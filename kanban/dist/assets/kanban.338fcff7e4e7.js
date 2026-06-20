const state = {
      data: null,
      config: null,
      date: '',
      warehouse: 'all',
      query: '',
      loading: false,
    };
    const CONFIG_STORAGE_KEY = 'mao-kanban-config-v1';
    const DEFAULT_CONFIG = {
      dataUrl: './kanban-data.json',
      appId: '',
      hasAppSecret: false,
      authReady: false,
      rawUrl: '',
      rulesUrl: '',
      manualUrl: '',
      reviewUrl: '',
      writebackEnabled: false,
    };

    const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
    const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const pct = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
    function num(value) {
      return Number.isFinite(value) ? value : 0;
    }

    function formatNum(value) {
      return Number.isFinite(value) ? fmt.format(value) : '-';
    }

    function formatMoney(value) {
      return Number.isFinite(value) ? '￥' + money.format(value) : '-';
    }

    function formatPct(value) {
      return Number.isFinite(value) ? pct.format(value) : '-';
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function day() {
      return state.data?.days?.[state.date] || { kpis: {}, warehouseRows: [], skuRows: [], warehouseSkuRows: [] };
    }

    function dateText(value) {
      return String(value || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3');
    }

    function showMessage(html, kind = '') {
      const node = document.getElementById('message');
      node.innerHTML = html ? '<div class="' + (kind || 'empty') + '">' + html + '</div>' : '';
    }

    function openConfigModal() {
      const modal = document.getElementById('configModal');
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      document.getElementById('rawUrlInput').focus();
    }

    function closeConfigModal() {
      const modal = document.getElementById('configModal');
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      document.getElementById('configButton').focus();
    }

    function renderWarnings() {
      const warnings = state.data?.warnings || [];
      if (!warnings.length) return '';
      return '<div class="warnings">' + warnings.map((warning) => '<div class="warning">' + esc(warning) + '</div>').join('') + '</div>';
    }

    function renderConfig() {
      const config = state.config || {};
      document.getElementById('dataUrlInput').value = config.dataUrl || './kanban-data.json';
      document.getElementById('appIdInput').value = config.appId || '';
      document.getElementById('appSecretInput').value = '';
      document.getElementById('appSecretInput').placeholder = config.hasAppSecret ? '已配置，留空不修改' : '请输入 App Secret';
      document.getElementById('rawUrlInput').value = config.rawUrl || '';
      document.getElementById('rulesUrlInput').value = config.rulesUrl || '';
      document.getElementById('manualUrlInput').value = config.manualUrl || '';
      document.getElementById('reviewUrlInput').value = config.reviewUrl || '';
      document.getElementById('writebackInput').checked = config.writebackEnabled !== false;
      const authText = config.authReady ? '飞书凭证已配置' : '配置已保存在当前浏览器';
      const reviewText = config.reviewUrl ? '复盘表已配置' : '复盘表未配置';
      document.getElementById('configStatus').textContent = authText + ' · ' + reviewText;
    }

    function normalizeConfig(config) {
      return {
        ...DEFAULT_CONFIG,
        ...(config || {}),
        dataUrl: String(config?.dataUrl || DEFAULT_CONFIG.dataUrl).trim() || DEFAULT_CONFIG.dataUrl,
        appSecret: undefined,
        hasAppSecret: Boolean(config?.hasAppSecret || config?.appSecret),
        authReady: Boolean(config?.appId && (config?.hasAppSecret || config?.appSecret)),
        writebackEnabled: Boolean(config?.writebackEnabled),
      };
    }

    function loadConfig() {
      let stored = null;
      try {
        stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
      } catch {}
      state.config = normalizeConfig(stored);
      renderConfig();
    }

    function readConfigForm() {
      const appSecret = document.getElementById('appSecretInput').value.trim();
      const current = state.config || DEFAULT_CONFIG;
      return normalizeConfig({
        dataUrl: document.getElementById('dataUrlInput').value.trim(),
        appId: document.getElementById('appIdInput').value.trim(),
        appSecret,
        hasAppSecret: appSecret ? true : Boolean(current.hasAppSecret),
        rawUrl: document.getElementById('rawUrlInput').value.trim(),
        rulesUrl: document.getElementById('rulesUrlInput').value.trim(),
        manualUrl: document.getElementById('manualUrlInput').value.trim(),
        reviewUrl: document.getElementById('reviewUrlInput').value.trim(),
        writebackEnabled: document.getElementById('writebackInput').checked,
      });
    }

    function publicConfig(config = state.config) {
      const { appSecret, ...safeConfig } = normalizeConfig(config);
      return safeConfig;
    }

    async function saveConfig() {
      const button = document.getElementById('saveConfigButton');
      button.disabled = true;
      button.textContent = '保存中';
      document.getElementById('configStatus').textContent = '保存中';
      try {
        state.config = readConfigForm();
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(publicConfig(state.config), null, 2));
        renderConfig();
        document.getElementById('configStatus').textContent = '已保存到当前浏览器';
        await loadData(true);
      } catch (error) {
        document.getElementById('configStatus').textContent = error.message;
      } finally {
        button.disabled = false;
        button.textContent = '保存到本机';
      }
    }

    function exportConfig() {
      const blob = new Blob([JSON.stringify(publicConfig(readConfigForm()), null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'kanban-config.json';
      link.click();
      URL.revokeObjectURL(url);
      document.getElementById('configStatus').textContent = '配置 JSON 已导出';
    }

    async function importConfigFile(file) {
      if (!file) return;
      const text = await file.text();
      const imported = normalizeConfig(JSON.parse(text));
      state.config = publicConfig(imported);
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config, null, 2));
      renderConfig();
      document.getElementById('configStatus').textContent = '配置 JSON 已导入';
      await loadData(true);
    }

    async function loadData(forceRefresh = false) {
      if (state.loading) return;
      state.loading = true;
      const button = document.getElementById('refreshButton');
      button.disabled = true;
      button.textContent = '刷新中';
      try {
        const dataUrl = state.config?.dataUrl || './kanban-data.json';
        const cacheBustedUrl = forceRefresh
          ? dataUrl + (dataUrl.includes('?') ? '&' : '?') + 't=' + Date.now()
          : dataUrl;
        const response = await fetch(cacheBustedUrl, { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || payload.error) throw new Error(payload.error || '看板数据读取失败');
        state.data = payload;
        window.KANBAN_DAILY_DATA = payload.days || {};
        window.KANBAN_SOURCE = payload.source || {};
        if (!state.date || !payload.dates.includes(state.date)) state.date = payload.dates[payload.dates.length - 1] || '';
        if (!state.date) showMessage('没有可展示的日期数据。');
        render();
      } catch (error) {
        showMessage(esc(error.message), 'error');
      } finally {
        state.loading = false;
        button.disabled = false;
        button.textContent = '刷新';
      }
    }

    function renderDateSelect() {
      const select = document.getElementById('dateSelect');
      const dates = state.data?.dates || [];
      select.innerHTML = dates.map((date) => '<option value="' + esc(date) + '">' + esc(date) + '</option>').join('');
      select.value = state.date;
    }

    function renderWarehouseSelect() {
      const select = document.getElementById('warehouseSelect');
      const rows = day().warehouseRows || [];
      const options = ['<option value="all">全部仓库</option>'].concat(rows.map((row) => (
        '<option value="' + esc(row.key) + '">' + esc(row.name) + '</option>'
      )));
      select.innerHTML = options.join('');
      if (!['all', ...rows.map((row) => row.key)].includes(state.warehouse)) state.warehouse = 'all';
      select.value = state.warehouse;
    }

    function renderSourceStatus() {
      const source = state.data?.source;
      const refreshed = state.data?.refreshedAt ? new Date(state.data.refreshedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
      document.getElementById('sourceStatus').textContent = source
        ? 'raw ' + source.rawRowCount + ' 行 · 手动 ' + (source.manualInputRowCount || 0) + ' 行 · 大看板 ' + source.bigBoardFieldCount + ' 字段 · 单品 ' + source.smallBoardFieldCount + ' 字段 · ' + refreshed
        : '读取静态看板数据';
    }

    function renderKpis() {
      const kpis = day().kpis || {};
      document.getElementById('kpiAmount').textContent = formatMoney(kpis.amount);
      document.getElementById('kpiAmountHint').textContent = state.date ? dateText(state.date) + ' 销额合计' : '-';
      document.getElementById('kpiSales').textContent = formatNum(kpis.sales);
      document.getElementById('kpiSalesHint').textContent = state.date ? dateText(state.date) + ' 销量合计' : '-';
      document.getElementById('kpiGrossProfit').textContent = formatMoney(kpis.grossProfit);
      document.getElementById('kpiProfitMargin').textContent = formatPct(kpis.profitMargin);
      document.getElementById('kpiRisk').textContent = formatNum(kpis.riskSkuCount) + ' / ' + formatNum(kpis.skuCount);
      document.getElementById('kpiRiskHint').textContent = '补货 ' + formatNum(kpis.criticalSkuCount);
    }

    function renderWarehouseCards() {
      const current = day();
      const rows = current.kanban?.big?.rows || [];
      const metricByKey = new Map((current.warehouseRows || []).map((row) => [row.key, row]));
      document.getElementById('warehouseSummary').textContent = rows.length
        ? rows.length + ' 个仓库 · 库存预警 SKU ' + (current.warehouseRows || []).reduce((sum, row) => sum + num(row.riskSkuCount), 0)
        : '-';
      document.getElementById('warehouseGrid').innerHTML = rows.length ? rows.map((row) => (
        (() => {
          const metrics = metricByKey.get(row.key) || {};
          const statCells = [
            { label: '销量', display: formatNum(metrics.sales) },
            { label: '销额', display: formatMoney(metrics.amount) },
            { label: '仓储成本', display: formatMoney(metrics.totalStorageFee) },
            { label: '毛利合计', display: formatMoney(metrics.grossProfit), subDisplay: formatPct(metrics.profitMargin), className: 'profit-stat' },
          ];
          const stockWarningText = '总 SKU ' + formatNum(metrics.skuCount) + ' 个 · 库存预警 ' + formatNum(metrics.riskSkuCount) + ' 个'
            + (num(metrics.criticalSkuCount) ? ' · 补货 ' + formatNum(metrics.criticalSkuCount) + ' 个' : '');
          return (
        '<button type="button" class="warehouse-card ' + esc(row.status) + (state.warehouse === row.key ? ' active' : '') + '" data-warehouse="' + esc(row.key) + '">' +
          '<div class="warehouse-title"><strong>' + esc(row.warehouse || row.name) + '</strong><span class="badge ' + esc(row.status) + '">' + esc(row.statusLabel) + '</span></div>' +
          '<div class="warehouse-stats">' +
            statCells.map((cell) => (
              '<div class="stat ' + esc(cell.className || '') + '"><span>' + esc(cell.label) + '</span><strong>' + esc(cell.display) + '</strong>' +
              (cell.subDisplay ? '<small class="stat-sub">' + esc(cell.subDisplay) + '</small>' : '') +
              '</div>'
            )).join('') +
          '</div>' +
          '<div class="forecast-accuracy" title="销量 / 仓库预估总销售数"><span>销量预估准确率</span><strong>' + esc(formatPct(metrics.achievement)) + '</strong></div>' +
          '<div class="status-line warehouse-status">' + esc(stockWarningText) + '</div>' +
        '</button>'
          );
        })()
      )).join('') : '<div class="empty">没有仓库数据。</div>';

      document.querySelectorAll('.warehouse-card[data-warehouse]').forEach((card) => {
        card.addEventListener('click', () => {
          state.warehouse = card.dataset.warehouse || 'all';
          render();
        });
      });
    }

    function rowName(row) {
      return row.name || row.displayName || row.skuName || row.skuId || '-';
    }

    function rowSku(row) {
      return row.skuId || row.skuIds?.[0] || row.key || '-';
    }

    function rowWarehouse(row) {
      if (row.warehouse) return row.warehouseGroup && row.warehouseGroup !== row.warehouse
        ? row.warehouseGroup + ' / ' + row.warehouse
        : row.warehouse;
      return (row.warehouses || []).join(' / ') || '-';
    }

    function cellValue(row, label) {
      if (row.values && Object.prototype.hasOwnProperty.call(row.values, label)) return row.values[label];
      const cell = (row.cells || []).find((item) => item.label === label);
      return cell?.value;
    }

    function rowAvailableStock(row) {
      const value = Number(cellValue(row, '累计可用库存'));
      return Number.isFinite(value) ? value : null;
    }

    function rowTurnoverDays(row) {
      const value = Number(cellValue(row, '周转天数'));
      return Number.isFinite(value) ? value : null;
    }

    function selectedSkuRows() {
      const current = day();
      let rows = current.kanban?.small?.rows || [];
      if (state.warehouse !== 'all') rows = rows.filter((row) => normalizeRowKey(row.warehouseGroup || row.warehouse) === state.warehouse);
      const query = state.query.toLowerCase();
      if (query) {
        rows = rows.filter((row) => {
          return [rowSku(row), rowName(row), rowWarehouse(row), ...(row.cells || []).map((cell) => cell.display)]
            .some((value) => String(value || '').toLowerCase().includes(query));
        });
      }
      return prioritizeSkuRows(rows);
    }

    function normalizeRowKey(value) {
      return String(value || '').toLowerCase();
    }

    function skuAttentionRank(row) {
      const availableStock = rowAvailableStock(row);
      if (Number.isFinite(availableStock) && availableStock < 0) return 0;
      const turnoverDays = rowTurnoverDays(row);
      if (Number.isFinite(turnoverDays) && turnoverDays < 2) return 1;
      if (row.status === 'bad') return 0;
      if (row.status === 'warn') return 1;
      return 2;
    }

    function prioritizeSkuRows(rows) {
      return rows.map((row, index) => ({ row, index })).sort((a, b) => {
        const priority = skuAttentionRank(a.row) - skuAttentionRank(b.row);
        if (priority) return priority;
        return num(a.row.sourceOrder) - num(b.row.sourceOrder) || a.index - b.index;
      }).map((item) => item.row);
    }

    function cellAttention(row, field) {
      const computedAttention = computedRowAttention(row);
      const attention = computedAttention || row.attention;
      if (!attention) return null;
      const labelKeys = attention.keys || [];
      const valueKeys = attention.valueKeys || [];
      const labelNames = attention.labels || [];
      const valueNames = attention.valueLabels || [];
      const hasLabel = labelKeys.includes(field.key) || labelNames.includes(field.label);
      const hasValue = valueKeys.includes(field.key) || valueNames.includes(field.label);
      if (!hasLabel && !hasValue) return null;
      return {
        ...attention,
        showNote: hasLabel,
      };
    }

    function computedRowAttention(row) {
      const labels = ['周转天数'];
      const valueLabels = ['累计可用库存', '周转天数'];
      const availableStock = rowAvailableStock(row);
      if (Number.isFinite(availableStock) && availableStock < 0) {
        return { severity: 'bad', note: '补货', labels, valueLabels, reason: '累计可用库存为负' };
      }
      const turnoverDays = rowTurnoverDays(row);
      if (Number.isFinite(turnoverDays) && turnoverDays < 2) {
        return { severity: 'warn', note: '关注', labels, valueLabels, reason: '周转天数低于2天' };
      }
      if (Number.isFinite(availableStock) || Number.isFinite(turnoverDays)) {
        return { severity: 'ok', note: '充足', labels, valueLabels, reason: '累计可用库存和周转天数充足' };
      }
      return null;
    }

    function attentionNote(attention) {
      if (!attention) return '';
      const noteClass = (attention.severity === 'bad' || attention.severity === 'warn' || attention.severity === 'ok')
        ? attention.severity + '-note'
        : 'warn-note';
      return '<small class="sku-alert-note ' + noteClass + '" title="' + esc(attention.reason || '') + '">' + esc(attention.note || '') + '</small>';
    }

    function attentionValueClass(attention) {
      if (!attention) return '';
      if (attention.severity === 'bad') return ' bad-value';
      if (attention.severity === 'warn') return ' warn-value';
      if (attention.severity === 'ok') return ' ok-value';
      return '';
    }

    function renderSkuCell(row, field) {
      const cell = (row.cells || []).find((item) => item.key === field.key);
      let text = cell?.display ?? '-';
      if (field.label === '周转天数') {
        const availableStock = rowAvailableStock(row);
        if (Number.isFinite(availableStock) && availableStock < 0) text = '-';
      }
      const attention = cellAttention(row, field);
      const note = attention?.showNote ? attentionNote(attention) : '';
      if (field.label === '产品名称') {
        return '<td><div class="sku-name" title="' + esc(text) + '"><span class="sku-name-text">' + esc(text) + '</span>' + note + '</div></td>';
      }
      if (note) return '<td><div class="cell-with-note"><span class="sku-cell-value' + attentionValueClass(attention) + '">' + esc(text) + '</span>' + note + '</div></td>';
      if (attention) return '<td><div><span class="sku-cell-value' + attentionValueClass(attention) + '">' + esc(text) + '</span></div></td>';
      return '<td><div>' + esc(text) + '</div></td>';
    }

    function renderSkuTable() {
      const rows = selectedSkuRows();
      const fields = day().kanban?.small?.fields || [];
      document.getElementById('skuHead').innerHTML = fields.map((field) => (
        '<th>' + esc(field.label) + '</th>'
      )).join('');
      document.getElementById('skuSummary').textContent = rows.length
        ? rows.length + ' 行 · 当前仓库 ' + (state.warehouse === 'all' ? '全部' : document.querySelector('#warehouseSelect option:checked')?.textContent || '-')
        : '-';
      document.getElementById('skuBody').innerHTML = rows.map((row) => {
        return '<tr>' +
          fields.map((field) => renderSkuCell(row, field)).join('') +
        '</tr>';
      }).join('');
    }

    function selectedDayJson() {
      const selected = day();
      return JSON.stringify(selected, null, 2);
    }

    function renderDayJson() {
      const json = selectedDayJson();
      document.getElementById('dayJson').textContent = json;
      document.getElementById('jsonSummary').textContent = state.date ? state.date + ' · ' + Math.ceil(json.length / 1024) + ' KB' : '-';
    }

    function render() {
      showMessage(renderWarnings());
      renderDateSelect();
      renderWarehouseSelect();
      renderSourceStatus();
      renderKpis();
      renderWarehouseCards();
      renderSkuTable();
      renderDayJson();
    }

    function initEvents() {
      const modal = document.getElementById('configModal');
      const dialog = document.getElementById('configDialog');
      document.getElementById('dateSelect').addEventListener('change', (event) => {
        state.date = event.target.value;
        state.warehouse = 'all';
        render();
      });
      document.getElementById('warehouseSelect').addEventListener('change', (event) => {
        state.warehouse = event.target.value;
        render();
      });
      document.getElementById('searchInput').addEventListener('input', (event) => {
        state.query = event.target.value.trim();
        renderSkuTable();
      });
      document.getElementById('refreshButton').addEventListener('click', () => loadData(true));
      document.getElementById('configButton').addEventListener('click', openConfigModal);
      document.getElementById('closeConfigButton').addEventListener('click', closeConfigModal);
      document.getElementById('saveConfigButton').addEventListener('click', saveConfig);
      document.getElementById('exportConfigButton').addEventListener('click', exportConfig);
      document.getElementById('importConfigButton').addEventListener('click', () => document.getElementById('importConfigFile').click());
      document.getElementById('importConfigFile').addEventListener('change', async (event) => {
        await importConfigFile(event.target.files?.[0]);
        event.target.value = '';
      });
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeConfigModal();
      });
      dialog.addEventListener('click', (event) => event.stopPropagation());
      modal.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
      modal.addEventListener('touchmove', (event) => event.stopPropagation(), { passive: true });
      dialog.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
      dialog.addEventListener('touchmove', (event) => event.stopPropagation(), { passive: true });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) closeConfigModal();
      });
      document.getElementById('copyJsonButton').addEventListener('click', async () => {
        await navigator.clipboard.writeText(selectedDayJson());
      });
      document.getElementById('downloadJsonButton').addEventListener('click', () => {
        const blob = new Blob([selectedDayJson()], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'kanban-' + (state.date || 'day') + '.json';
        link.click();
        URL.revokeObjectURL(url);
      });
    }

    initEvents();
    loadConfig();
    loadData(false);
    window.setInterval(() => loadData(true), 60000);
