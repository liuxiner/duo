import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const RAW_HEADERS_PREFIX = ['采集时间', '销售日期', '页面', '商品名称', '商品ID'];
const CALCULATED_HEADERS = ['采集时间', '销售日期', '商品名称', '商品ID', '仓库信息', '仓库总库存', '仓库预估总销售数', '销售数(份)', '商家报价', '实际均价'];

function envBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function envInt(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) ? number : defaultValue;
}

async function loadDotEnv(file = '.env') {
  let text;
  try {
    text = await readFile(path.resolve(ROOT, file), 'utf8');
  } catch {
    return;
  }

  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}

function config() {
  return {
    pddUrl: process.env.PDD_GOODS_MANAGE_URL || 'https://mc.pinduoduo.com/ddmc-supplier-product/goods-manage',
    profileDir: path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile'),
    browserChannel: process.env.PDD_BROWSER_CHANNEL || '',
    chromiumSandbox: envBool(process.env.PDD_CHROMIUM_SANDBOX, true),
    cdpUrl: process.env.PDD_CDP_URL || '',
    headless: envBool(process.env.PDD_HEADLESS, false),
    maxPages: envInt(process.env.PDD_MAX_PAGES, 20),
    targetPageSize: envInt(process.env.PDD_TARGET_PAGE_SIZE, 100),
    selectYesterday: envBool(process.env.PDD_SELECT_YESTERDAY, true),
    syncDate: process.env.PDD_SYNC_DATE || '',
    dateFrom: process.env.PDD_DATE_FROM || '',
    dateTo: process.env.PDD_DATE_TO || '',
    autoWaitForLogin: envBool(process.env.PDD_AUTO_WAIT_FOR_LOGIN, false),
    loginWaitMs: envInt(process.env.PDD_LOGIN_WAIT_MS, 5 * 60 * 1000),
    waitForLogin: envBool(process.env.PDD_WAIT_FOR_LOGIN, true),
    outputDir: path.resolve(ROOT, process.env.PDD_OUTPUT_DIR || 'data/pdd'),
    latestJson: path.resolve(ROOT, process.env.PDD_LATEST_JSON || 'data/latest.json'),
    latestCsv: path.resolve(ROOT, process.env.PDD_LATEST_CSV || 'data/latest.csv'),
    feishuAppId: process.env.FEISHU_APP_ID || '',
    feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
    feishuWikiUrl: process.env.FEISHU_WIKI_URL || '',
    feishuWikiNodeToken: process.env.FEISHU_WIKI_NODE_TOKEN || '',
    feishuSpreadsheetToken: process.env.FEISHU_SPREADSHEET_TOKEN || '',
    feishuSheetId: process.env.FEISHU_SHEET_ID || '',
    feishuStartCell: process.env.FEISHU_START_CELL || 'A1',
    feishuDailySheetNameFormat: process.env.FEISHU_DAILY_SHEET_NAME_FORMAT || 'YYYY-MM-DD',
    feishuClearExtraRows: envInt(process.env.FEISHU_CLEAR_EXTRA_ROWS, 200),
  };
}

function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatBeijingTimestamp(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}`;
}

function formatBeijingDate(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateFromYmd(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date();
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function yesterdayBeijingDate() {
  return formatBeijingDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function validateYmd(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }
  const date = dateFromYmd(value);
  if (formatBeijingDate(date) !== value) throw new Error(`${name} is not a valid date: ${value}`);
  return value;
}

function datesBetween(from, to) {
  validateYmd(from, 'PDD_DATE_FROM');
  validateYmd(to, 'PDD_DATE_TO');
  const start = dateFromYmd(from);
  const end = dateFromYmd(to);
  if (start > end) throw new Error('PDD_DATE_FROM cannot be later than PDD_DATE_TO.');

  const dates = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(formatBeijingDate(cursor));
  }
  return dates;
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function dedupeRows(rows) {
  const seen = new Set();
  const result = [];
  rows.forEach((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(row);
  });
  return result;
}

function normalizeHeaders(headers) {
  const result = [...RAW_HEADERS_PREFIX];
  headers.forEach((header, index) => {
    const clean = header || `列${index + 1}`;
    if (!result.includes(clean)) result.push(clean);
  });
  return result;
}

function normalizeRow(record, headers, collectedAt, salesDate, pageUrl) {
  const productName = record.product?.name || record['商品名称'] || record['商品信息'] || '';
  const productId = record.product?.id || record['商品ID'] || '';
  const row = {
    采集时间: collectedAt,
    销售日期: salesDate,
    页面: pageUrl,
    商品名称: productName,
    商品ID: productId,
    ...record,
  };
  delete row.product;
  return headers.map((header) => row[header] ?? '');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  const matches = normalizeText(text).matchAll(/￥?\s*(\d+(?:\.\d+)?)/g);
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

function calculatedRowsFromRecords(records, collectedAt, salesDate) {
  const groups = new Map();

  records.forEach((record) => {
    const name = record.product?.name || record['商品名称'] || record['商品信息'] || '';
    const id = record.product?.id || record['商品ID'] || '';
    const warehouse = cleanWarehouseText(record['仓库信息']);
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

    group.stockTotal = addQuantity(group.stockTotal, parseLeadingQuantity(record['仓库总库存']));
    group.estimateTotal = addQuantity(group.estimateTotal, parseLeadingQuantity(record['仓库预估总销售数']));

    const quantities = parseSalesQuantities(record['销售数(份)']);
    const prices = parsePrices(record['商家报价']);
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
      collectedAt,
      salesDate,
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

async function waitForManualLogin(page, cfg) {
  if (!cfg.waitForLogin) return;

  if (cfg.autoWaitForLogin) {
    console.log('Waiting for PDD login/verification in the opened browser...');
    const deadline = Date.now() + cfg.loginWaitMs;
    while (Date.now() < deadline) {
      const hasTable = await page.locator('table, [data-testid="beast-core-table"]').first().count().catch(() => 0);
      if (hasTable > 0) {
        console.log('PDD table detected. Continuing sync.');
        return;
      }
      await page.waitForTimeout(1500);
    }
    throw new Error(`Timed out after ${Math.round(cfg.loginWaitMs / 1000)} seconds waiting for PDD login.`);
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const hasTable = await page.locator('table, [data-testid="beast-core-table"]').first().count().catch(() => 0);
    if (hasTable > 0) return;

    const pageTitle = await page.title().catch(() => '');
    const pageUrl = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const isVerification = /扫码|二维码|验证|验证码|登录|安全|手机|短信|人机|请完成/.test(`${pageTitle}\n${pageUrl}\n${bodyText}`);

    console.log('');
    console.log('PDD login/verification handoff required.');
    console.log(`Current page: ${pageTitle || '(no title)'}`);
    console.log(pageUrl);
    if (isVerification) {
      console.log('The browser appears to be on a login, QR code, or security verification page.');
    } else {
      console.log('No goods table was detected yet.');
    }
    console.log('Please finish login/scan/verification in the opened browser window.');
    console.log('After the goods manage table is visible, return here and press Enter.');

    const rl = createInterface({ input, output });
    await rl.question('');
    rl.close();

    const afterEnterHasTable = await page.locator('table, [data-testid="beast-core-table"]').first().count().catch(() => 0);
    if (afterEnterHasTable > 0) return;

    console.log('Re-opening goods manage page after manual login...');
    await page.goto(cfg.pddUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  throw new Error('Still could not find the PDD goods table after manual login/verification handoff.');
}

async function collectCurrentPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const cellText = (cell) => {
      const clone = cell.cloneNode(true);
      clone.querySelectorAll('svg,img').forEach((node) => node.remove());
      return normalize(clone.textContent);
    };

    const parseProduct = (cell) => {
      const name = normalize(cell.querySelector('[class*="good_info"] p, [class*="goods_info"] p, p')?.textContent);
      const idText = normalize(cell.querySelector('[class*="good_info"] span, [class*="goods_info"] span, span')?.textContent);
      const id = (idText.match(/ID[:：]?\s*(\d+)/i) || [])[1] || '';
      return { name, id };
    };

    const tableRoot = document.querySelector('[data-testid="beast-core-table"]') || document;
    const middleHeader = tableRoot.querySelector('[data-testid="beast-core-table-middle-header"]');
    const middleBody = tableRoot.querySelector('[data-testid="beast-core-table-middle-body"]');
    const headerCells = middleHeader
      ? middleHeader.querySelectorAll('th')
      : tableRoot.querySelectorAll('thead th');
    const headers = Array.from(headerCells).map((th) => normalize(th.textContent)).filter(Boolean);

    const bodyRows = middleBody
      ? middleBody.querySelectorAll('tbody tr')
      : tableRoot.querySelectorAll('tbody tr');

    const records = Array.from(bodyRows).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (!cells.length) return null;

      const record = {};
      cells.forEach((cell, index) => {
        const header = headers[index] || `列${index + 1}`;
        record[header] = cellText(cell);
      });

      const productIndex = headers.indexOf('商品信息');
      const productCell = cells[productIndex >= 0 ? productIndex : 0];
      record.product = parseProduct(productCell);
      return record;
    }).filter((record) => {
      if (!record) return false;
      return Object.values(record).some((value) => {
        if (typeof value === 'object') return value.name || value.id;
        return normalize(value);
      });
    });

    return { headers, records };
  });
}

async function readTotalCount(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/共有\s*(\d+)\s*条/);
    return match ? Number(match[1]) : null;
  }).catch(() => null);
}

async function currentPageSize(page) {
  return page.evaluate(() => {
    const sizeChanger = document.querySelector('.PGT_sizeChanger_5-157-0');
    const input = sizeChanger?.querySelector('input[data-testid="beast-core-select-htmlInput"], input');
    const value = input?.value || '';
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
  }).catch(() => null);
}

async function waitForQueryResults(page, salesDate, targetPageSize, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let stableMatches = 0;
  let lastState = { rowCount: 0, total: null, pageSize: null, dates: [] };

  while (Date.now() < deadline) {
    const [result, total, selectedPageSize] = await Promise.all([
      collectCurrentPage(page),
      readTotalCount(page),
      currentPageSize(page),
    ]);
    const dates = Array.from(new Set(
      result.records.map((record) => normalizeText(record['销售日期'])).filter(Boolean)
    ));
    const pageSize = selectedPageSize || targetPageSize || result.records.length;
    const expectedRows = Number.isFinite(total) ? Math.min(total, pageSize) : null;
    const dateMatches = dates.length === 0 || dates.every((date) => date === salesDate);
    const countMatches = expectedRows == null ? result.records.length > 0 : result.records.length === expectedRows;

    lastState = { rowCount: result.records.length, total, pageSize, dates };
    if (dateMatches && countMatches) {
      stableMatches += 1;
      if (stableMatches >= 2) return { result, total, pageSize };
    } else {
      stableMatches = 0;
    }
    await page.waitForTimeout(750);
  }

  throw new Error(
    `PDD query did not stabilize for ${salesDate}: `
    + `visible rows ${lastState.rowCount}, total ${lastState.total ?? 'unknown'}, `
    + `page size ${lastState.pageSize ?? 'unknown'}, dates ${lastState.dates.join(', ') || 'unknown'}.`
  );
}

async function setDateRangeTo(page, salesDate) {
  const selector = 'input[data-testid="beast-core-rangePicker-htmlInput"]';
  const inputLocator = page.locator(selector).first();
  const previousTableText = await page.locator('[data-testid="beast-core-table-middle-body"]')
    .innerText({ timeout: 3000 }).catch(() => '');
  const count = await inputLocator.count().catch(() => 0);
  if (!count) {
    console.log('Date range input not found; continuing with current page date.');
    return false;
  }

  const targetValue = `${salesDate} ~ ${salesDate}`;
  const currentValue = await inputLocator.inputValue().catch(() => '');
  if (currentValue === targetValue) {
    console.log(`Date range already set to ${targetValue}.`);
    return true;
  }

  console.log(`Setting date range to ${targetValue}.`);
  await inputLocator.click();
  await page.locator('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]').waitFor({ timeout: 8000 });

  for (let i = 0; i < 2; i += 1) {
    await clickRangePickerDate(page, salesDate);
    await page.waitForTimeout(350);
  }

  const confirmButton = page
    .locator('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]')
    .locator('button')
    .filter({ hasText: /^确认$/ })
    .first();
  if (await confirmButton.count().catch(() => 0)) {
    await confirmButton.click();
    await page.waitForTimeout(500);
  } else {
    await page.keyboard.press('Escape');
  }

  const selectedValue = await inputLocator.inputValue().catch(() => '');
  if (selectedValue !== targetValue) {
    throw new Error(`Date picker did not accept ${targetValue}; current value is ${selectedValue || '(empty)'}.`);
  }

  const queryButton = page.locator('button').filter({ hasText: /^查询$/ }).first();
  if (await queryButton.count().catch(() => 0)) {
    await queryButton.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    if (previousTableText) {
      await page.waitForFunction((previous) => {
        const body = document.querySelector('[data-testid="beast-core-table-middle-body"]');
        return body && body.innerText !== previous;
      }, previousTableText, { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
  } else {
    console.log('Query button not found after date update.');
  }
  return true;
}

async function clickRangePickerDate(page, salesDate) {
  const [, monthText, dayText] = salesDate.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  if (!monthText || !dayText) throw new Error(`Invalid sales date: ${salesDate}`);
  const monthLabel = `${Number(monthText)}月`;
  const dayLabel = String(Number(dayText));

  const clicked = await page.evaluate(({ monthLabel: targetMonth, dayLabel: targetDay }) => {
    const root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]');
    if (!root) return { ok: false, reason: 'range picker root not found' };

    const months = Array.from(root.querySelectorAll('.RPR_dateText_5-157-0')).map((node) => node.textContent?.trim());
    const tables = Array.from(root.querySelectorAll('table[data-testid="beast-core-rangePicker-table"]'));
    const panelIndex = months.findIndex((month) => month === targetMonth);
    const table = tables[panelIndex >= 0 ? panelIndex : 0];
    if (!table) return { ok: false, reason: `month panel not found: ${targetMonth}; visible=${months.join(',')}` };

    const cells = Array.from(table.querySelectorAll('.RPR_cell_5-157-0'))
      .filter((cell) => !cell.className.includes('RPR_outOfMonth_5-157-0'));
    const cell = cells.find((candidate) => candidate.textContent?.trim() === targetDay);
    if (!cell) return { ok: false, reason: `day not found: ${targetDay}; month=${targetMonth}` };

    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return { ok: true };
  }, { monthLabel, dayLabel });

  if (!clicked.ok) {
    throw new Error(`Failed to click date ${salesDate}: ${clicked.reason}`);
  }
}

async function setPageSize(page, targetSize) {
  if (!targetSize) return false;
  const current = await currentPageSize(page);
  if (current === targetSize) {
    console.log(`Page size already ${targetSize}.`);
    return true;
  }

  console.log(`Trying to set page size to ${targetSize}.`);
  const sizeChanger = page.locator('.PGT_sizeChanger_5-157-0').first();
  if (!(await sizeChanger.count().catch(() => 0))) {
    console.log('Page size control not found; will paginate with current page size.');
    return false;
  }

  await sizeChanger.click();
  await page.waitForTimeout(500);

  const exactOption = page.locator('[role="option"], li, div, span').filter({ hasText: new RegExp(`^\\s*${targetSize}\\s*$`) }).last();
  if (await exactOption.count().catch(() => 0)) {
    await exactOption.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const updated = await currentPageSize(page);
    if (updated === targetSize) {
      console.log(`Page size set to ${targetSize}.`);
      return true;
    }
  }

  console.log(`Could not set page size to ${targetSize}; will paginate with current page size ${current || 'unknown'}.`);
  return false;
}

async function clickNextPage(page) {
  const beforeText = await page.locator('[data-testid="beast-core-table-middle-body"]').innerText({ timeout: 3000 }).catch(() => '');
  const clicked = await page.evaluate(() => {
    const dispatchClick = (node) => {
      if (!node) return false;
      const className = node.getAttribute('class') || '';
      if (/disabled/i.test(className) || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('disabled') != null) {
        return false;
      }
      ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    };

    const next = document.querySelector('[data-testid="beast-core-pagination-next"]');
    if (dispatchClick(next)) return { ok: true, method: 'next' };

    const active = document.querySelector('.PGT_pagerItemActive_5-157-0');
    const current = Number(active?.textContent?.trim());
    if (Number.isFinite(current)) {
      const items = Array.from(document.querySelectorAll('.PGT_pagerItem_5-157-0'));
      const nextItem = items.find((item) => Number(item.textContent?.trim()) === current + 1);
      if (dispatchClick(nextItem)) return { ok: true, method: `page-${current + 1}` };
    }

    return { ok: false, method: 'none' };
  });

  if (!clicked.ok) {
    console.log('No next page control available.');
    return false;
  }

  console.log(`Clicked pagination control: ${clicked.method}.`);
  await page.waitForFunction((previous) => {
    const body = document.querySelector('[data-testid="beast-core-table-middle-body"]');
    return body && body.innerText !== previous;
  }, beforeText, { timeout: 10000 }).catch(() => page.waitForTimeout(1500));
  return true;
}

async function collectPddRows(cfg) {
  const { chromium } = await import('playwright');
  let browser;
  let context;

  if (cfg.cdpUrl) {
    browser = await chromium.connectOverCDP(cfg.cdpUrl);
    context = browser.contexts()[0] || await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: 'zh-CN',
    });
  } else {
    context = await chromium.launchPersistentContext(cfg.profileDir, {
      headless: cfg.headless,
      channel: cfg.browserChannel || undefined,
      chromiumSandbox: cfg.chromiumSandbox,
      viewport: { width: 1440, height: 960 },
      locale: 'zh-CN',
    });
  }

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(cfg.pddUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await waitForManualLogin(page, cfg);

    const collectedAt = formatBeijingTimestamp(new Date());
    const salesDate = cfg.syncDate || (cfg.selectYesterday ? yesterdayBeijingDate() : formatBeijingDate(new Date()));
    if (cfg.syncDate) validateYmd(cfg.syncDate, 'PDD_SYNC_DATE');
    if (cfg.syncDate || cfg.selectYesterday) {
      await setDateRangeTo(page, salesDate);
    }
    await setPageSize(page, cfg.targetPageSize);
    const stableQuery = await waitForQueryResults(page, salesDate, cfg.targetPageSize);
    const expectedTotal = stableQuery.total;
    console.log(`Query stabilized: ${stableQuery.result.records.length} visible rows, ${expectedTotal ?? 'unknown'} total.`);

    const allRecords = [];
    let headers = [];

    for (let pageIndex = 1; pageIndex <= cfg.maxPages; pageIndex += 1) {
      const result = pageIndex === 1 ? stableQuery.result : await collectCurrentPage(page);
      if (!headers.length && result.headers.length) headers = result.headers;
      allRecords.push(...result.records);
      console.log(`Collected page ${pageIndex}: ${result.records.length} rows.`);
      if (expectedTotal && allRecords.length >= expectedTotal) break;

      const hasNext = await clickNextPage(page);
      if (!hasNext) break;
    }

    const tableDates = Array.from(new Set(allRecords.map((record) => normalizeText(record['销售日期'])).filter(Boolean)));
    const mismatchedDates = tableDates.filter((date) => date !== salesDate);
    if ((cfg.syncDate || cfg.selectYesterday) && mismatchedDates.length) {
      throw new Error(`Sales date validation failed: expected ${salesDate}, table has ${tableDates.join(', ')}.`);
    }

    headers = normalizeHeaders(headers);
    const rawRows = dedupeRows(allRecords.map((record) => normalizeRow(record, headers, collectedAt, salesDate, page.url())));
    const calculatedRows = calculatedRowsFromRecords(allRecords, collectedAt, salesDate);
    if (expectedTotal && rawRows.length !== expectedTotal) {
      throw new Error(`PDD row count validation failed: collected ${rawRows.length}, page total ${expectedTotal}.`);
    }
    console.log(`Validated collected rows: ${rawRows.length}${expectedTotal ? ` / ${expectedTotal}` : ''}.`);
    console.log(`Calculated merged rows: ${calculatedRows.length}.`);
    return {
      collectedAt,
      salesDate,
      headers: CALCULATED_HEADERS,
      rows: calculatedRows,
      rawHeaders: headers,
      rawRows,
      sourceUrl: page.url(),
      expectedTotal,
    };
  } finally {
    if (browser) await browser.close();
    else await context.close();
  }
}

async function getTenantAccessToken(cfg) {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: cfg.feishuAppId,
      app_secret: cfg.feishuAppSecret,
    }),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`Failed to get Feishu tenant token: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body.tenant_access_token;
}

function extractWikiNodeToken(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  return match ? match[1] : text;
}

function formatDailySheetName(date, format) {
  const pad = (value) => String(value).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  return String(format || 'YYYY-MM-DD')
    .replace(/YYYY/g, yyyy)
    .replace(/MM/g, mm)
    .replace(/DD/g, dd);
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu API failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function resolveSpreadsheetToken(cfg, token) {
  if (cfg.feishuSpreadsheetToken) {
    console.log(`Using configured Feishu spreadsheet token: ${cfg.feishuSpreadsheetToken}`);
    return cfg.feishuSpreadsheetToken;
  }

  const wikiNodeToken = extractWikiNodeToken(cfg.feishuWikiNodeToken || cfg.feishuWikiUrl);
  if (!wikiNodeToken) {
    throw new Error('Set FEISHU_WIKI_URL or FEISHU_WIKI_NODE_TOKEN, or set FEISHU_SPREADSHEET_TOKEN directly.');
  }
  console.log(`Resolving Feishu wiki node: ${wikiNodeToken}`);

  const search = new URLSearchParams({ token: wikiNodeToken });
  const body = await feishuJson(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?${search}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const node = body.data?.node || body.data || {};
  const objType = node.obj_type || node.objType;
  const objToken = node.obj_token || node.objToken;
  if (objType && !['sheet', 'bitable'].includes(String(objType).toLowerCase())) {
    throw new Error(`Wiki node is ${objType}, not a spreadsheet. Open/create a Feishu spreadsheet under the wiki node.`);
  }
  if (!objToken) {
    throw new Error(`Could not resolve spreadsheet token from wiki node ${wikiNodeToken}. Response: ${JSON.stringify(body)}`);
  }
  console.log(`Resolved Feishu ${objType || 'sheet'} token: ${objToken}`);
  return objToken;
}

async function listFeishuSheets(spreadsheetToken, token) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return body.data?.sheets || body.data?.items || [];
}

function sheetTitle(sheet) {
  return sheet.title || sheet.name || sheet.properties?.title || '';
}

function sheetId(sheet) {
  return sheet.sheet_id || sheet.sheetId || sheet.properties?.sheet_id || sheet.properties?.sheetId || '';
}

async function createFeishuSheet(spreadsheetToken, title, token) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/sheets_batch_update`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title,
              },
            },
          },
        ],
      }),
    }
  );

  const reply = body.data?.replies?.[0]?.addSheet || body.data?.replies?.[0] || {};
  const properties = reply.properties || reply;
  const id = sheetId(properties) || properties.sheet_id || properties.sheetId;
  if (!id) {
    const sheets = await listFeishuSheets(spreadsheetToken, token);
    const created = sheets.find((sheet) => sheetTitle(sheet) === title);
    if (created) return sheetId(created);
    throw new Error(`Created sheet but could not determine sheet id. Response: ${JSON.stringify(body)}`);
  }
  return id;
}

async function ensureDailySheet(cfg, spreadsheetToken, token, date) {
  if (cfg.feishuSheetId) return cfg.feishuSheetId;

  const title = formatDailySheetName(date, cfg.feishuDailySheetNameFormat);
  const sheets = await listFeishuSheets(spreadsheetToken, token);
  const existing = sheets.find((sheet) => sheetTitle(sheet) === title);
  if (existing) {
    const id = sheetId(existing);
    if (id) return id;
  }
  console.log(`Creating Feishu sheet: ${title}`);
  return createFeishuSheet(spreadsheetToken, title, token);
}

function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function startCellParts(cell) {
  const match = String(cell).match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`Invalid FEISHU_START_CELL: ${cell}`);
  return { col: match[1].toUpperCase(), row: Number(match[2]) };
}

function buildFeishuValues(headers, rows, extraBlankRows) {
  const values = [headers, ...rows];
  const width = headers.length;
  for (let i = 0; i < extraBlankRows; i += 1) {
    values.push(Array.from({ length: width }, () => ''));
  }
  return values;
}

async function writeToFeishu(cfg, headers, rows) {
  if (!cfg.feishuAppId || !cfg.feishuAppSecret) {
    console.log('Feishu env is incomplete. Skipping Feishu write.');
    return;
  }

  const token = await getTenantAccessToken(cfg);
  const spreadsheetToken = await resolveSpreadsheetToken(cfg, token);
  const sheetIdForWrite = await ensureDailySheet(cfg, spreadsheetToken, token, dateFromYmd(rows[0]?.[1]));
  const values = buildFeishuValues(headers, rows, cfg.feishuClearExtraRows);
  const start = startCellParts(cfg.feishuStartCell);
  const endCol = columnName(headers.length - 1);
  const endRow = start.row + values.length - 1;
  const range = `${sheetIdForWrite}!${start.col}${start.row}:${endCol}${endRow}`;

  const response = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        valueRange: { range, values },
      }),
    }
  );
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`Failed to write Feishu sheet: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  console.log(`Wrote ${rows.length} rows to Feishu range ${range}.`);
}

async function writeLocalFiles(cfg, payload) {
  await mkdir(cfg.outputDir, { recursive: true });
  await mkdir(path.dirname(cfg.latestJson), { recursive: true });
  await mkdir(path.dirname(cfg.latestCsv), { recursive: true });

  const stamp = payload.collectedAt || timestampForFile();
  const csv = toCsv(payload.headers, payload.rows);
  const json = JSON.stringify(payload, null, 2);
  const rawCsv = payload.rawHeaders && payload.rawRows ? toCsv(payload.rawHeaders, payload.rawRows) : '';
  const snapshotCsv = path.join(cfg.outputDir, `pdd-orders-calculated-${stamp}.csv`);
  const snapshotJson = path.join(cfg.outputDir, `pdd-orders-${stamp}.json`);
  const snapshotRawCsv = path.join(cfg.outputDir, `pdd-orders-raw-${stamp}.csv`);

  await writeFile(snapshotCsv, csv, 'utf8');
  await writeFile(snapshotJson, json, 'utf8');
  await writeFile(cfg.latestCsv, csv, 'utf8');
  await writeFile(cfg.latestJson, json, 'utf8');
  if (rawCsv) await writeFile(snapshotRawCsv, rawCsv, 'utf8');

  console.log(`Wrote ${payload.rows.length} calculated rows to ${cfg.latestCsv}`);
  if (rawCsv) console.log(`Wrote ${payload.rawRows.length} raw rows to ${snapshotRawCsv}`);
  console.log(`Wrote JSON to ${cfg.latestJson}`);
}

async function main() {
  await loadDotEnv();
  const cfg = config();
  const dates = cfg.dateFrom || cfg.dateTo
    ? datesBetween(cfg.dateFrom || cfg.dateTo, cfg.dateTo || cfg.dateFrom)
    : [cfg.syncDate || (cfg.selectYesterday ? yesterdayBeijingDate() : formatBeijingDate(new Date()))];

  console.log(`Syncing ${dates.length} date(s): ${dates[0]} -> ${dates[dates.length - 1]}`);
  for (const date of dates) {
    console.log(`\n=== Sync ${date} ===`);
    const payload = await collectPddRows({ ...cfg, syncDate: date });
    await writeLocalFiles(cfg, payload);
    await writeToFeishu(cfg, payload.headers, payload.rows);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
