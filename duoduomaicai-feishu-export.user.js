// ==UserScript==
// @name         多多买菜订货管理库存导出到飞书
// @namespace    https://xcn413dmlc7m.feishu.cn/
// @version      1.0.0
// @description  Export 商品信息 and inventory/sales columns from 多多买菜订货管理 for direct paste into Feishu Excel.
// @match        https://*.pinduoduo.com/*
// @match        https://*.yangkeduo.com/*
// @match        https://*.duoduomaicai.com/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const FEISHU_EXCEL_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/QQbkwQPd0i5e0ckqtfpcVlQynVe';
  const EXPORT_HEADERS = ['商品名称', '商品ID', '仓库信息', '仓库总库存', '仓库预估总销售数', '销售数(份)', '商家报价', '实际均价'];

  const css = `
    #ddmc-feishu-export {
      position: fixed;
      right: 20px;
      bottom: 24px;
      z-index: 2147483647;
      display: flex;
      gap: 8px;
      align-items: center;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #ddmc-feishu-export button {
      border: 0;
      border-radius: 6px;
      padding: 9px 12px;
      background: #1677ff;
      color: #fff;
      box-shadow: 0 6px 18px rgba(0,0,0,.16);
      cursor: pointer;
    }
    #ddmc-feishu-export button:disabled {
      cursor: wait;
      opacity: .7;
    }
    #ddmc-feishu-export .status {
      max-width: 340px;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(0,0,0,.78);
      color: #fff;
      word-break: break-word;
    }
  `;

  function installStyle() {
    if (document.getElementById('ddmc-feishu-export-style')) return;
    const style = document.createElement('style');
    style.id = 'ddmc-feishu-export-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cellText(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('svg,img').forEach((node) => node.remove());
    clone.querySelectorAll('a').forEach((node) => {
      if (normalizeText(node.textContent) === '查看') node.remove();
    });
    return normalizeText(clone.textContent);
  }

  function findMiddleTable() {
    return document.querySelector('[data-testid="beast-core-table-middle-body"] table');
  }

  function getHeaders() {
    const ths = document.querySelectorAll('[data-testid="beast-core-table-middle-header"] th');
    return Array.from(ths).map((th) => normalizeText(th.textContent));
  }

  function parseProduct(cell) {
    const name = normalizeText(cell.querySelector('.management_good_info__LfnbI p, p')?.textContent);
    const idText = normalizeText(cell.querySelector('.management_good_info__LfnbI span, span')?.textContent);
    const id = (idText.match(/ID[:：]?\s*(\d+)/i) || [])[1] || idText.replace(/^ID[:：]?\s*/i, '');
    return { name, id };
  }

  function parseLeadingQuantity(text) {
    const match = normalizeText(text).match(/(-?\d+(?:\.\d+)?)\s*份?/);
    return match ? Number(match[1]) : null;
  }

  function parseSalesQuantities(text) {
    const matches = normalizeText(text).matchAll(/(\d+(?:\.\d+)?)(?=\s*(?:份|已截单|$))/g);
    return Array.from(matches, (match) => Number(match[1])).filter(Number.isFinite);
  }

  function parsePrices(text) {
    const matches = normalizeText(text).matchAll(/￥\s*(\d+(?:\.\d+)?)/g);
    return Array.from(matches, (match) => Number(match[1])).filter(Number.isFinite);
  }

  function formatQuantity(value) {
    if (!Number.isFinite(value)) return '--';
    return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}份`;
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return '--';
    return `￥${Number(value.toFixed(2))}`;
  }

  function addQuantity(current, next) {
    return Number.isFinite(next) ? (current || 0) + next : current;
  }

  function cleanWarehouseText(text) {
    return normalizeText(text).replace(/查看地址/g, '').trim();
  }

  function mergeRows(rows) {
    const groups = new Map();

    rows.forEach((row) => {
      const [name, id, warehouse, stockText, estimateText, salesText, priceText] = row;
      const key = `${id || name}::${warehouse}`;
      if (!groups.has(key)) {
        groups.set(key, {
          name,
          id,
          warehouse,
          stockTotal: null,
          estimateTotal: null,
          salesTotal: 0,
          weightedAmount: 0,
          weightedQuantity: 0,
          prices: new Set(),
        });
      }

      const group = groups.get(key);
      if (!group.name && name) group.name = name;
      if (!group.id && id) group.id = id;
      if (!group.warehouse && warehouse) group.warehouse = warehouse;

      group.stockTotal = addQuantity(group.stockTotal, parseLeadingQuantity(stockText));
      group.estimateTotal = addQuantity(group.estimateTotal, parseLeadingQuantity(estimateText));

      const quantities = parseSalesQuantities(salesText);
      const prices = parsePrices(priceText);
      quantities.forEach((quantity) => {
        if (Number.isFinite(quantity)) group.salesTotal += quantity;
      });
      prices.forEach((price) => group.prices.add(formatPrice(price)));

      quantities.forEach((quantity, index) => {
        const price = prices[index] ?? (prices.length === 1 ? prices[0] : null);
        if (Number.isFinite(quantity) && Number.isFinite(price)) {
          group.weightedAmount += quantity * price;
          group.weightedQuantity += quantity;
        }
      });
    });

    return Array.from(groups.values()).map((group) => {
      const average = group.weightedQuantity > 0 ? group.weightedAmount / group.weightedQuantity : null;
      return [
        group.name,
        group.id,
        group.warehouse,
        formatQuantity(group.stockTotal),
        formatQuantity(group.estimateTotal),
        formatQuantity(group.salesTotal),
        Array.from(group.prices).join(' / ') || '--',
        formatPrice(average),
      ];
    });
  }

  function extractRows() {
    const headers = getHeaders();
    const productIndex = headers.indexOf('商品信息');
    const warehouseIndex = headers.indexOf('仓库信息');
    const requiredColumns = ['仓库总库存', '仓库预估总销售数', '销售数(份)', '商家报价'];
    const columnIndexes = requiredColumns.map((name) => headers.indexOf(name));
    const table = findMiddleTable();

    if (!table || productIndex < 0 || warehouseIndex < 0 || columnIndexes.some((index) => index < 0)) {
      throw new Error('没有找到“商品信息 / 仓库信息 / 仓库总库存 / 仓库预估总销售数 / 销售数(份) / 商家报价”表格，请确认当前页是订货管理列表且数据已加载。');
    }

    const rows = Array.from(table.querySelectorAll('tbody tr'))
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (cells.length <= Math.max(productIndex, warehouseIndex, ...columnIndexes)) return null;

        const product = parseProduct(cells[productIndex]);
        const warehouse = cleanWarehouseText(cellText(cells[warehouseIndex]));
        const values = columnIndexes.map((index) => cellText(cells[index]));
        if (!product.name && !product.id && values.every((value) => !value)) return null;

        return [product.name, product.id, warehouse, ...values];
      })
      .filter(Boolean);

    if (!rows.length) throw new Error('表格里没有可导出的行。');
    return mergeRows(rows);
  }

  function toTsv(values) {
    return values.map((row) => row.map((cell) => {
      return String(cell ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    }).join('\t')).join('\n');
  }

  function setStatus(text) {
    const status = document.querySelector('#ddmc-feishu-export .status');
    if (status) status.textContent = text;
  }

  function runExport(button) {
    button.disabled = true;
    try {
      setStatus('正在读取表格...');
      const bodyRows = extractRows();
      const values = [EXPORT_HEADERS, ...bodyRows];
      const tsv = toTsv(values);

      GM_setClipboard(tsv, 'text');
      window.open(FEISHU_EXCEL_URL, '_blank', 'noopener,noreferrer');
      setStatus(`已复制 ${bodyRows.length} 行。飞书打开后选中 A1，直接粘贴。`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function installButton() {
    if (document.getElementById('ddmc-feishu-export')) return;
    installStyle();

    const wrapper = document.createElement('div');
    wrapper.id = 'ddmc-feishu-export';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '复制库存并打开飞书';
    button.addEventListener('click', () => runExport(button));

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = '等待导出';

    wrapper.append(button, status);
    document.body.appendChild(wrapper);
  }

  const timer = window.setInterval(() => {
    if (document.body) {
      installButton();
      window.clearInterval(timer);
    }
  }, 500);
})();
