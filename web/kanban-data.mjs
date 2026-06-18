const DEFAULT_RAW_SOURCE_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/EChawQEHEipllvkxqMycZL3Yn7c';
const DEFAULT_RULES_SOURCE_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/VY6Pw5l9piRdzIk3mQ4c5icrnib';
const DEFAULT_REVIEW_TARGET_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/H4QTwsAcJiUzZ5kaHr9cMJHpnCc';
const DEFAULT_THRESHOLD_DAYS = 7;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_COLUMNS = 80;
const CACHE_TTL_MS = 30 * 1000;
const WRITEBACK_TTL_MS = 5 * 60 * 1000;
const REVIEW_SHEET_PREFIX = '看板复盘';
const STORAGE_FEE_LABEL = '总仓储费用';
const STORAGE_FEE_PART_LABELS = ['技术服务费', '多货费', '云仓费用', '共享仓费用', '其他仓储费'];

let cachedPayload = null;
let lastWriteback = null;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeHeaderKey(value) {
  return normalizeText(value)
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[：:]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function isBlankRow(row) {
  return !row || row.every((cell) => normalizeText(cell) === '');
}

function trimTrailingBlankRows(values) {
  const rows = Array.isArray(values) ? values.map((row) => Array.isArray(row) ? row : []) : [];
  while (rows.length && isBlankRow(rows[rows.length - 1])) rows.pop();
  return rows;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value).replace(/,/g, '');
  if (!text || /^--?$/.test(text)) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value).replace(/,/g, '');
  const numbers = Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g), (match) => Number(match[0]))
    .filter(Number.isFinite);
  if (!numbers.length) return null;
  return numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
}

function firstFinite(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
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

function truthyEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function friendlyFeishuError(error) {
  const message = error?.message || String(error || '');
  if (/91403|Forbidden|HTTP 403/i.test(message)) {
    return '飞书返回 403 Forbidden：当前飞书应用对复盘表没有编辑权限，请把复盘表分享给该自建应用并授予可编辑权限。';
  }
  return message;
}

function sheetTitle(sheet) {
  return sheet.title || sheet.name || sheet.properties?.title || '';
}

function sheetId(sheet) {
  return sheet.sheet_id || sheet.sheetId || sheet.properties?.sheet_id || sheet.properties?.sheetId || '';
}

function sheetDateKey(title) {
  const match = normalizeText(title).match(/^(?:看板复盘-)?(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : '';
}

function sheetGrid(sheet) {
  const grid = sheet.grid_properties || sheet.gridProperties || sheet.properties?.grid_properties || sheet.properties?.gridProperties || {};
  return {
    rowCount: Number(grid.row_count || grid.rowCount || sheet.row_count || sheet.rowCount || DEFAULT_MAX_ROWS),
    columnCount: Number(grid.column_count || grid.columnCount || sheet.column_count || sheet.columnCount || DEFAULT_MAX_COLUMNS),
  };
}

function extractWikiNodeToken(value) {
  const text = normalizeText(value);
  const match = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  return match ? match[1] : text;
}

function extractSpreadsheetToken(value) {
  const text = normalizeText(value);
  const match = text.match(/\/sheets\/([A-Za-z0-9]+)/);
  return match ? match[1] : '';
}

function extractSheetIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get('sheet') || '';
  } catch {
    return '';
  }
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu API failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function getTenantAccessToken() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法读取飞书表格。');
  }
  const body = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!body.tenant_access_token) throw new Error('飞书鉴权成功但没有返回 tenant_access_token。');
  return body.tenant_access_token;
}

async function resolveSpreadsheet(sourceUrl, tenantToken) {
  const directToken = extractSpreadsheetToken(sourceUrl);
  if (directToken) {
    return {
      spreadsheetToken: directToken,
      fixedSheetId: extractSheetIdFromUrl(sourceUrl),
      objectType: 'sheet',
    };
  }

  const wikiNodeToken = extractWikiNodeToken(sourceUrl);
  if (!wikiNodeToken) throw new Error('飞书数据源 URL 为空。');
  const search = new URLSearchParams({ token: wikiNodeToken });
  const body = await feishuJson(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?${search}`, {
    headers: { Authorization: `Bearer ${tenantToken}` },
  });
  const node = body.data?.node || body.data || {};
  const objectType = String(node.obj_type || node.objType || '').toLowerCase();
  const spreadsheetToken = node.obj_token || node.objToken;

  if (objectType && !['sheet', 'spreadsheet'].includes(objectType)) {
    throw new Error(`飞书 wiki 节点类型是 ${objectType}，不是电子表格。`);
  }
  if (!spreadsheetToken) throw new Error(`无法从 wiki 节点解析表格 token：${wikiNodeToken}`);
  return { spreadsheetToken, fixedSheetId: '', objectType: objectType || 'sheet' };
}

async function listFeishuSheets(spreadsheetToken, tenantToken) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    { headers: { Authorization: `Bearer ${tenantToken}` } }
  );
  return body.data?.sheets || body.data?.items || [];
}

async function updateFeishuSheetIndex(spreadsheetToken, tenantToken, sheetIdForMove, index) {
  await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/sheets_batch_update`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        requests: [
          {
            updateSheet: {
              properties: {
                sheetId: sheetIdForMove,
                index,
              },
            },
          },
        ],
      }),
    }
  );
}

async function sortFeishuSheetsByDate(spreadsheetToken, tenantToken) {
  const sheets = await listFeishuSheets(spreadsheetToken, tenantToken);
  const datedSheets = sheets
    .map((sheet, index) => ({
      index,
      id: sheetId(sheet),
      title: sheetTitle(sheet),
      dateKey: sheetDateKey(sheetTitle(sheet)),
    }))
    .filter((sheet) => sheet.id && sheet.dateKey)
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  const alreadySorted = datedSheets.every((sheet, index) => sheet.index === index);
  if (alreadySorted) return { moved: 0, total: datedSheets.length };

  for (let index = 0; index < datedSheets.length; index += 1) {
    await updateFeishuSheetIndex(spreadsheetToken, tenantToken, datedSheets[index].id, index);
  }
  return { moved: datedSheets.length, total: datedSheets.length };
}

async function createFeishuSheet(spreadsheetToken, title, tenantToken) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/sheets_batch_update`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: { title },
            },
          },
        ],
      }),
    }
  );
  const reply = body.data?.replies?.[0]?.addSheet || body.data?.replies?.[0] || {};
  const properties = reply.properties || reply;
  const id = sheetId(properties) || properties.sheet_id || properties.sheetId;
  if (id) return id;

  const sheets = await listFeishuSheets(spreadsheetToken, tenantToken);
  const created = sheets.find((sheet) => sheetTitle(sheet) === title);
  if (created) return sheetId(created);
  throw new Error(`创建飞书复盘 sheet 后无法获取 sheet id：${title}`);
}

async function ensureFeishuSheet(spreadsheetToken, title, tenantToken) {
  const sheets = await listFeishuSheets(spreadsheetToken, tenantToken);
  const existing = sheets.find((sheet) => sheetTitle(sheet) === title);
  const existingId = existing ? sheetId(existing) : '';
  return existingId || createFeishuSheet(spreadsheetToken, title, tenantToken);
}

function withBlankRows(values, count = 200) {
  const width = Math.max(...values.map((row) => row.length), 1);
  const blanks = Array.from({ length: count }, () => Array.from({ length: width }, () => ''));
  return values.concat(blanks);
}

async function writeValuesToFeishu(spreadsheetToken, sheetIdForWrite, values, tenantToken) {
  const width = Math.max(...values.map((row) => row.length), 1);
  const range = `${sheetIdForWrite}!A1:${columnName(width - 1)}${values.length}`;
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        valueRange: { range, values },
      }),
    }
  );
  return { range, updatedCells: body.data?.updatedCells || body.data?.updated_cells || null };
}

async function readSheetValues(spreadsheetToken, sheet, tenantToken) {
  const id = sheetId(sheet);
  if (!id) return [];
  const grid = sheetGrid(sheet);
  const maxRows = Math.min(Math.max(grid.rowCount || DEFAULT_MAX_ROWS, 100), DEFAULT_MAX_ROWS);
  const maxColumns = Math.min(Math.max(grid.columnCount || DEFAULT_MAX_COLUMNS, 10), DEFAULT_MAX_COLUMNS);
  const range = `${id}!A1:${columnName(maxColumns - 1)}${maxRows}`;
  const query = new URLSearchParams({
    valueRenderOption: 'ToString',
    dateTimeRenderOption: 'FormattedString',
  });
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}?${query}`,
    { headers: { Authorization: `Bearer ${tenantToken}` } }
  );
  return trimTrailingBlankRows(body.data?.valueRange?.values || body.data?.value_range?.values || []);
}

async function readFeishuSpreadsheet(sourceUrl, tenantToken) {
  const resolved = await resolveSpreadsheet(sourceUrl, tenantToken);
  let sheets = await listFeishuSheets(resolved.spreadsheetToken, tenantToken);
  if (resolved.fixedSheetId) {
    sheets = sheets.filter((sheet) => sheetId(sheet) === resolved.fixedSheetId);
  }
  const readableSheets = sheets.filter((sheet) => sheetId(sheet));
  const withValues = await Promise.all(readableSheets.map(async (sheet) => ({
    id: sheetId(sheet),
    title: sheetTitle(sheet),
    values: await readSheetValues(resolved.spreadsheetToken, sheet, tenantToken),
  })));
  return {
    sourceUrl,
    spreadsheetToken: resolved.spreadsheetToken,
    sheetCount: withValues.length,
    sheets: withValues,
  };
}

const RAW_ALIASES = {
  collectedAt: ['采集时间', '更新时间', '同步时间'],
  salesDate: ['销售日期', '日期', '统计日期', '数据日期'],
  name: ['商品名称', '商品信息', '名称', '品名'],
  skuId: ['商品ID', '商品id', 'SKUID', 'SKU ID', 'sku_id', 'sku'],
  warehouse: ['仓库信息', '仓库', '仓库名称', '仓库名', '仓库组'],
  stock: ['仓库总库存', '总库存', '库存', '剩余库存', '库存数'],
  estimate: ['仓库预估总销售数', '预估总销售数', '预估销售数', '预估日销', '预计日销', '目标日销'],
  sales: ['销售数(份)', '销售数（份）', '销售数', '销量', '当日销量', '仓库总销售数'],
  quote: ['商家报价', '报价', '商家报价(元)', '商家报价（元）'],
  price: ['实际均价', '均价', '成交均价', '实际价格', '价格'],
};

const RULE_ALIASES = {
  warehouse: ['仓库', '仓库信息', '仓库名称', '仓库名', '仓库组'],
  warehouseGroup: ['大看板', '大看板分组', '仓库分组', '展示仓库', '分仓库展示', '仓库组'],
  skuId: ['SKUID', 'SKU ID', 'sku_id', 'sku', '商品ID', '商品id', '小看板'],
  skuName: ['商品名称', 'SKU名称', '品名', '名称'],
  targetSales: ['目标日销', '日销目标', '预期日销', '目标销量', '销量目标', '销售目标', '计划销量'],
  targetStock: ['安全库存', '目标库存', '库存目标', '补货线', '补货阈值库存'],
  thresholdDays: ['补货阈值', '阈值天数', '安全天数', '周转天数', '库存天数'],
  enabled: ['启用', '是否启用', '状态', '是否展示'],
  priority: ['排序', '优先级', '展示顺序'],
  owner: ['负责人', '跟进人'],
  note: ['备注', '规则说明', '说明'],
};

function headerIndex(headers, aliases) {
  const normalized = headers.map(normalizeHeaderKey);
  return aliases
    .map(normalizeHeaderKey)
    .map((alias) => normalized.indexOf(alias))
    .find((index) => index >= 0) ?? -1;
}

function headerValue(row, indexes, key) {
  const index = indexes[key];
  return index >= 0 ? row[index] : '';
}

function buildIndexes(headers, aliases) {
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headerIndex(headers, names)]));
}

function findCalculatedHeaderRow(values) {
  return values.findIndex((row) => {
    const headers = row.map(normalizeText);
    const indexes = buildIndexes(headers, RAW_ALIASES);
    return indexes.skuId >= 0 && indexes.warehouse >= 0 && (indexes.sales >= 0 || indexes.stock >= 0);
  });
}

function formatDateParts(year, month, day) {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function currentShanghaiYear() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'year')?.value) || new Date().getFullYear();
}

function parseDate(value, fallbackYear = currentShanghaiYear()) {
  const text = normalizeText(value);
  if (!text) return '';
  let match = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/(\d{1,2})[-/.月](\d{1,2})(?:日)?/);
  if (match) return formatDateParts(fallbackYear, Number(match[1]), Number(match[2]));
  return '';
}

function parseCalculatedSheet(sheet) {
  const values = trimTrailingBlankRows(sheet.values);
  const headerRow = findCalculatedHeaderRow(values);
  if (headerRow < 0) return [];
  const headers = values[headerRow].map(normalizeText);
  const indexes = buildIndexes(headers, RAW_ALIASES);
  const fallbackDate = parseDate(sheet.title);

  return values.slice(headerRow + 1).map((row) => {
    const skuId = normalizeText(headerValue(row, indexes, 'skuId'));
    const name = normalizeText(headerValue(row, indexes, 'name'));
    const warehouse = normalizeText(headerValue(row, indexes, 'warehouse')) || '未分仓库';
    const date = parseDate(headerValue(row, indexes, 'salesDate')) || fallbackDate;
    const sales = parseNumber(headerValue(row, indexes, 'sales')) || 0;
    const stock = parseNumber(headerValue(row, indexes, 'stock'));
    const estimate = parseNumber(headerValue(row, indexes, 'estimate'));
    const price = firstFinite(
      parsePrice(headerValue(row, indexes, 'price')),
      parsePrice(headerValue(row, indexes, 'quote'))
    );
    const collectedAt = normalizeText(headerValue(row, indexes, 'collectedAt'));
    if (!date || (!skuId && !name) || (!warehouse && !Number.isFinite(sales) && !Number.isFinite(stock))) return null;
    return {
      date,
      skuId,
      name,
      warehouse,
      sales,
      stock,
      estimate,
      price,
      collectedAt,
      sourceSheet: sheet.title,
    };
  }).filter(Boolean);
}

function parseWideMonthlySheet(sheet) {
  const values = trimTrailingBlankRows(sheet.values);
  if (values.length < 3) return [];
  const top = values[0] || [];
  const second = values[1] || [];
  const dateStarts = top.map((cell, index) => ({ date: parseDate(cell), index })).filter((item) => item.date);
  if (!dateStarts.length) return [];

  const headers = second.map(normalizeText);
  const indexes = buildIndexes(headers, {
    name: RAW_ALIASES.name,
    skuId: RAW_ALIASES.skuId,
    warehouse: RAW_ALIASES.warehouse,
  });
  if (indexes.skuId < 0 && indexes.name < 0) return [];

  const rows = [];
  values.slice(2).forEach((row) => {
    const skuId = normalizeText(headerValue(row, indexes, 'skuId'));
    const name = normalizeText(headerValue(row, indexes, 'name'));
    const warehouse = normalizeText(headerValue(row, indexes, 'warehouse')) || '未分仓库';
    if (!skuId && !name) return;
    dateStarts.forEach(({ date, index }) => {
      const sales = parseNumber(row[index + 1]) || 0;
      const stock = parseNumber(row[index + 5]);
      const price = parsePrice(row[index]);
      if (!Number.isFinite(sales) && !Number.isFinite(stock)) return;
      rows.push({
        date,
        skuId,
        name,
        warehouse,
        sales,
        stock,
        estimate: null,
        price,
        collectedAt: '',
        sourceSheet: sheet.title,
      });
    });
  });
  return rows;
}

function parseRawRows(spreadsheet) {
  return spreadsheet.sheets
    .filter((sheet) => !sheet.title.startsWith(`${REVIEW_SHEET_PREFIX}-`))
    .flatMap((sheet) => {
    const calculatedRows = parseCalculatedSheet(sheet);
    return calculatedRows.length ? calculatedRows : parseWideMonthlySheet(sheet);
  });
}

function findBoardFieldHeaderRow(values) {
  return values.findIndex((row) => {
    const headers = row.map(normalizeText);
    return headerIndex(headers, ['仓库']) >= 0
      && headerIndex(headers, ['SKUID', '商品ID', '商品id']) >= 0
      && headerIndex(headers, ['产品名称', '商品名称']) >= 0;
  });
}

function selectedField(cell) {
  return /✅|yes|true|1|展示|需要/i.test(normalizeText(cell));
}

function fieldKey(label) {
  return normalizeHeaderKey(label) || 'field';
}

function fieldKind(label) {
  const key = normalizeHeaderKey(label);
  if (/日期/.test(label)) return 'date';
  if (/供价|单价|销额|成本|费用|服务费|仓储费|坑位费|扣费|售后|毛利/.test(label)) return 'money';
  if (/比例|扣点/.test(label)) return 'percent';
  if (/天数|周转/.test(label)) return 'days';
  if (/数量|销量|库存|剩余|日销|入库/.test(label)) return 'number';
  if (key === 'skuid') return 'text';
  return 'text';
}

function fieldsFromMarkerRow(headers, row) {
  return headers
    .map((label, index) => ({ label: normalizeText(label), index }))
    .filter((field) => field.label && selectedField(row[field.index]))
    .map((field) => ({
      key: fieldKey(field.label),
      label: field.label,
      kind: fieldKind(field.label),
      note: normalizeText(row[field.index]).replace(/✅/g, '').trim(),
    }));
}

function defaultBoardFields() {
  return {
    big: [
      { key: '仓库', label: '仓库', kind: 'text', note: '' },
      { key: '产品实时销量', label: '产品实时销量', kind: 'number', note: '' },
      { key: '产品日销额', label: '产品日销额', kind: 'money', note: '' },
      { key: STORAGE_FEE_LABEL, label: STORAGE_FEE_LABEL, kind: 'money', note: '' },
    ].map((field) => ({ ...field, key: fieldKey(field.key) })),
    small: [
      { key: 'SKUID', label: 'SKUID', kind: 'text', note: '' },
      { key: '销售日期', label: '销售日期', kind: 'date', note: '' },
      { key: '产品名称', label: '产品名称', kind: 'text', note: '' },
      { key: '产品实时销量', label: '产品实时销量', kind: 'number', note: '' },
      { key: '当天剩余库存', label: '当天剩余库存', kind: 'number', note: '' },
      { key: '累计可用库存', label: '累计可用库存', kind: 'number', note: '' },
      { key: '周转天数', label: '周转天数', kind: 'days', note: '' },
    ].map((field) => ({ ...field, key: fieldKey(field.key) })),
  };
}

function normalizeBigBoardFields(fields) {
  const storageKeys = new Set(STORAGE_FEE_PART_LABELS.map(fieldKey));
  const storageField = { key: fieldKey(STORAGE_FEE_LABEL), label: STORAGE_FEE_LABEL, kind: 'money', note: '技术服务费 + 多货费 + 云仓费用 + 共享仓费用 + 其他仓储费' };
  const filtered = fields.filter((field) => !storageKeys.has(field.key) && field.key !== storageField.key);
  const amountIndex = filtered.findIndex((field) => field.label === '产品日销额');
  if (amountIndex >= 0) {
    return filtered.slice(0, amountIndex + 1).concat(storageField, filtered.slice(amountIndex + 1));
  }
  return filtered.concat(storageField);
}

function parseBoardFieldRules(spreadsheet) {
  const defaults = defaultBoardFields();
  for (const sheet of spreadsheet.sheets) {
    const values = trimTrailingBlankRows(sheet.values);
    const headerRow = findBoardFieldHeaderRow(values);
    if (headerRow < 0) continue;
    const headers = values[headerRow].map(normalizeText);
    const smallRow = values.find((row, index) => index > headerRow && /小看板|单品/i.test(normalizeText(row[0])));
    const bigRow = values.find((row, index) => index > headerRow && /大看板|分仓库|仓库数据/i.test(normalizeText(row[0])));
    const small = smallRow ? fieldsFromMarkerRow(headers, smallRow) : [];
    const big = bigRow ? fieldsFromMarkerRow(headers, bigRow) : [];
    return {
      sourceSheet: sheet.title,
      headerRow: headerRow + 1,
      small: small.length ? small : defaults.small,
      big: normalizeBigBoardFields(big.length ? big : defaults.big),
    };
  }
  return {
    sourceSheet: '',
    headerRow: null,
    small: defaults.small,
    big: normalizeBigBoardFields(defaults.big),
  };
}

function findRuleHeaderRow(values) {
  return values.findIndex((row) => {
    const headers = row.map(normalizeText);
    const indexes = buildIndexes(headers, RULE_ALIASES);
    return indexes.skuId >= 0 || indexes.warehouse >= 0 || indexes.warehouseGroup >= 0;
  });
}

function enabledByValue(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  return !/^(0|false|否|不|停用|禁用|隐藏|no|n)$/.test(text);
}

function parseRules(spreadsheet) {
  const rules = [];
  for (const sheet of spreadsheet.sheets) {
    const values = trimTrailingBlankRows(sheet.values);
    if (values.some((row) => /小看板|大看板|分仓库数据|单品/.test(normalizeText(row[0])))) continue;
    const headerRow = findRuleHeaderRow(values);
    if (headerRow < 0) continue;
    const headers = values[headerRow].map(normalizeText);
    const indexes = buildIndexes(headers, RULE_ALIASES);
    values.slice(headerRow + 1).forEach((row) => {
      if (/小看板|大看板|分仓库数据|单品/.test(normalizeText(row[0]))) return;
      const rule = {
        warehouse: normalizeText(headerValue(row, indexes, 'warehouse')),
        warehouseGroup: normalizeText(headerValue(row, indexes, 'warehouseGroup')),
        skuId: normalizeText(headerValue(row, indexes, 'skuId')),
        skuName: normalizeText(headerValue(row, indexes, 'skuName')),
        targetSales: parseNumber(headerValue(row, indexes, 'targetSales')),
        targetStock: parseNumber(headerValue(row, indexes, 'targetStock')),
        thresholdDays: parseNumber(headerValue(row, indexes, 'thresholdDays')),
        priority: parseNumber(headerValue(row, indexes, 'priority')),
        owner: normalizeText(headerValue(row, indexes, 'owner')),
        note: normalizeText(headerValue(row, indexes, 'note')),
        sourceSheet: sheet.title,
      };
      rule.enabled = enabledByValue(headerValue(row, indexes, 'enabled'));
      const hasMeaningfulValue = rule.warehouse || rule.warehouseGroup || rule.skuId || rule.skuName
        || Number.isFinite(rule.targetSales) || Number.isFinite(rule.targetStock) || Number.isFinite(rule.thresholdDays);
      const looksLikeTemplateExample = !rule.warehouse && !rule.skuId && !rule.skuName
        && !Number.isFinite(rule.targetSales) && !Number.isFinite(rule.targetStock) && !Number.isFinite(rule.thresholdDays);
      if (hasMeaningfulValue && rule.enabled && !looksLikeTemplateExample) rules.push(rule);
    });
  }
  return rules;
}

function buildRuleIndex(rules) {
  const exact = new Map();
  const sku = new Map();
  const warehouse = new Map();
  const warehouseGroup = new Map();

  rules.forEach((rule) => {
    const skuKey = normalizeKey(rule.skuId);
    const warehouseKey = normalizeKey(rule.warehouse);
    const groupKey = normalizeKey(rule.warehouseGroup || rule.warehouse);
    if (skuKey && warehouseKey) exact.set(`${skuKey}::${warehouseKey}`, rule);
    if (skuKey && !sku.has(skuKey)) sku.set(skuKey, rule);
    if (warehouseKey && !warehouse.has(warehouseKey)) warehouse.set(warehouseKey, rule);
    if (groupKey && !warehouseGroup.has(groupKey)) warehouseGroup.set(groupKey, rule);
  });

  return {
    find(row) {
      const skuKey = normalizeKey(row.skuId);
      const warehouseKey = normalizeKey(row.warehouse);
      return exact.get(`${skuKey}::${warehouseKey}`)
        || sku.get(skuKey)
        || warehouse.get(warehouseKey)
        || null;
    },
    warehouseGroupFor(row) {
      const rule = this.find(row);
      if (rule?.warehouseGroup) return rule.warehouseGroup;
      const warehouseRule = warehouseGroup.get(normalizeKey(row.warehouse));
      return warehouseRule?.warehouseGroup || row.warehouse || '未分仓库';
    },
  };
}

function statusFor({ stock, expected, turnoverDays, thresholdDays }) {
  if (!Number.isFinite(expected) || expected <= 0) return 'info';
  if (Number.isFinite(stock) && stock < expected) return 'bad';
  if (Number.isFinite(turnoverDays) && turnoverDays <= Math.max(2, thresholdDays / 2)) return 'bad';
  if (Number.isFinite(turnoverDays) && turnoverDays <= thresholdDays) return 'warn';
  return 'ok';
}

function statusLabel(status) {
  return {
    bad: '立即补',
    warn: '需关注',
    ok: '充足',
    info: '无预期',
  }[status] || '无预期';
}

function rollingAverageSales(rows, lookback = 10) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${normalizeKey(row.skuId || row.name)}::${normalizeKey(row.warehouse)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const averages = new Map();
  groups.forEach((groupRows) => {
    groupRows.sort((a, b) => a.date.localeCompare(b.date));
    groupRows.forEach((row, index) => {
      const previous = groupRows.slice(Math.max(0, index - lookback), index);
      const denominator = previous.length || 1;
      const average = previous.length
        ? previous.reduce((sum, item) => sum + (Number.isFinite(item.sales) ? item.sales : 0), 0) / denominator
        : null;
      averages.set(row, average);
    });
  });
  return averages;
}

function warehouseType(warehouse) {
  const text = normalizeText(warehouse);
  if (/中心/.test(text)) return '中心仓';
  if (/共享/.test(text)) return '共享仓';
  return '云仓';
}

function sumFinite(...values) {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function enrichRows(rows, rules) {
  const ruleIndex = buildRuleIndex(rules);
  const tenDayAverages = rollingAverageSales(rows);
  return rows.map((row) => {
    const rule = ruleIndex.find(row);
    const thresholdDays = firstFinite(rule?.thresholdDays, DEFAULT_THRESHOLD_DAYS);
    const expected = firstFinite(rule?.targetSales, row.estimate, row.sales, 0);
    const stock = firstFinite(row.stock, 0);
    const safetyStock = firstFinite(rule?.targetStock, expected * thresholdDays, 0);
    const tenDayAverageSales = firstFinite(tenDayAverages.get(row), expected, row.sales, 0);
    const turnoverDays = tenDayAverageSales > 0 ? stock / tenDayAverageSales : expected > 0 ? stock / expected : null;
    const safetyGap = stock - safetyStock;
    const dailyGap = stock - expected;
    const status = statusFor({ stock, expected, turnoverDays, thresholdDays });
    const amount = Number.isFinite(row.price) ? row.sales * row.price : null;
    const inboundQuantity = null;
    const openingStock = Number.isFinite(stock) ? stock + row.sales : null;
    const cloudUnitPrice = row.price;
    const deductionRate = 0.04;
    const type = warehouseType(row.warehouse);
    const isCloudWarehouse = /云仓/.test(type);
    const technicalServiceFee = isCloudWarehouse ? row.sales * 0.165 : null;
    const overStockFee = isCloudWarehouse && Number.isFinite(inboundQuantity) ? (inboundQuantity - row.sales) * 0.1 : null;
    const cloudWarehouseFee = isCloudWarehouse && Number.isFinite(cloudUnitPrice) ? cloudUnitPrice : null;
    const sharedWarehouseFee = null;
    const otherWarehouseFee = null;
    const totalStorageFee = sumFinite(technicalServiceFee, overStockFee, cloudWarehouseFee, sharedWarehouseFee, otherWarehouseFee);
    return {
      ...row,
      warehouseGroup: ruleIndex.warehouseGroupFor(row),
      displayName: rule?.skuName || row.name || row.skuId || '未命名商品',
      expected,
      safetyStock,
      safetyGap,
      dailyGap,
      turnoverDays,
      tenDayAverageSales,
      thresholdDays,
      amount,
      settlementPrice: row.price,
      inboundQuantity,
      warehouseType: type,
      cloudUnitPrice,
      productCost: null,
      openingStock,
      dayEndStock: stock,
      centerStock: /中心/.test(row.warehouse) ? stock : null,
      availableStock: stock,
      technicalServiceFee,
      overStockFee,
      cloudWarehouseFee,
      sharedWarehouseFee,
      otherWarehouseFee,
      totalStorageFee,
      flashSaleSlotFee: null,
      deductionRate,
      platformFee: Number.isFinite(amount) ? amount * deductionRate : null,
      afterSalesFee: row.sales * 0.01,
      status,
      statusLabel: statusLabel(status),
      ruleNote: rule?.note || '',
      owner: rule?.owner || '',
      priority: rule?.priority ?? null,
      hasRule: Boolean(rule),
    };
  });
}

function emptyAggregate(key, name) {
  return {
    key,
    name,
    sales: 0,
    stock: 0,
    expected: 0,
    safetyStock: 0,
    amount: 0,
    amountRows: 0,
    technicalServiceFee: 0,
    overStockFee: 0,
    cloudWarehouseFee: 0,
    sharedWarehouseFee: 0,
    otherWarehouseFee: 0,
    totalStorageFee: 0,
    skuIds: new Set(),
    warehouses: new Set(),
    riskSkuCount: 0,
    criticalSkuCount: 0,
    itemCount: 0,
    minTurnoverDays: null,
    priority: null,
  };
}

function addToAggregate(aggregate, row) {
  aggregate.sales += row.sales || 0;
  aggregate.stock += row.stock || 0;
  aggregate.expected += row.expected || 0;
  aggregate.safetyStock += row.safetyStock || 0;
  if (Number.isFinite(row.amount)) {
    aggregate.amount += row.amount;
    aggregate.amountRows += 1;
  }
  aggregate.technicalServiceFee += Number.isFinite(row.technicalServiceFee) ? row.technicalServiceFee : 0;
  aggregate.overStockFee += Number.isFinite(row.overStockFee) ? row.overStockFee : 0;
  aggregate.cloudWarehouseFee += Number.isFinite(row.cloudWarehouseFee) ? row.cloudWarehouseFee : 0;
  aggregate.sharedWarehouseFee += Number.isFinite(row.sharedWarehouseFee) ? row.sharedWarehouseFee : 0;
  aggregate.otherWarehouseFee += Number.isFinite(row.otherWarehouseFee) ? row.otherWarehouseFee : 0;
  aggregate.totalStorageFee += Number.isFinite(row.totalStorageFee) ? row.totalStorageFee : 0;
  if (row.skuId) aggregate.skuIds.add(row.skuId);
  if (row.warehouse) aggregate.warehouses.add(row.warehouse);
  if (row.status === 'warn' || row.status === 'bad') aggregate.riskSkuCount += 1;
  if (row.status === 'bad') aggregate.criticalSkuCount += 1;
  if (Number.isFinite(row.turnoverDays)) {
    aggregate.minTurnoverDays = aggregate.minTurnoverDays == null
      ? row.turnoverDays
      : Math.min(aggregate.minTurnoverDays, row.turnoverDays);
  }
  aggregate.itemCount += 1;
  if (Number.isFinite(row.priority)) {
    aggregate.priority = aggregate.priority == null ? row.priority : Math.min(aggregate.priority, row.priority);
  }
}

function finishAggregate(aggregate) {
  const turnoverDays = aggregate.expected > 0 ? aggregate.stock / aggregate.expected : null;
  const safetyGap = aggregate.stock - aggregate.safetyStock;
  const achievement = aggregate.expected > 0 ? aggregate.sales / aggregate.expected : null;
  const status = aggregate.criticalSkuCount ? 'bad' : aggregate.riskSkuCount ? 'warn' : aggregate.expected > 0 ? 'ok' : 'info';
  return {
    ...aggregate,
    skuCount: aggregate.skuIds.size,
    warehouseCount: aggregate.warehouses.size,
    skuIds: Array.from(aggregate.skuIds),
    warehouses: Array.from(aggregate.warehouses),
    safetyGap,
    turnoverDays,
    achievement,
    status,
    statusLabel: statusLabel(status),
  };
}

function aggregateBy(rows, makeKey, makeName) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = makeKey(row);
    if (!groups.has(key)) groups.set(key, emptyAggregate(key, makeName(row)));
    addToAggregate(groups.get(key), row);
  });
  return Array.from(groups.values())
    .map(finishAggregate)
    .sort((a, b) => {
      const priorityA = Number.isFinite(a.priority) ? a.priority : Number.POSITIVE_INFINITY;
      const priorityB = Number.isFinite(b.priority) ? b.priority : Number.POSITIVE_INFINITY;
      if (priorityA !== priorityB) return priorityA - priorityB;
      if (b.criticalSkuCount !== a.criticalSkuCount) return b.criticalSkuCount - a.criticalSkuCount;
      if (b.riskSkuCount !== a.riskSkuCount) return b.riskSkuCount - a.riskSkuCount;
      return b.sales - a.sales;
    });
}

function makeKpis(rows) {
  const aggregate = finishAggregate(rows.reduce((acc, row) => {
    addToAggregate(acc, row);
    return acc;
  }, emptyAggregate('all', '全部')));
  return {
    sales: aggregate.sales,
    stock: aggregate.stock,
    expected: aggregate.expected,
    safetyGap: aggregate.safetyGap,
    skuCount: aggregate.skuCount,
    warehouseCount: aggregate.warehouseCount,
    riskSkuCount: aggregate.riskSkuCount,
    criticalSkuCount: aggregate.criticalSkuCount,
    turnoverDays: aggregate.turnoverDays,
    amount: aggregate.amountRows ? aggregate.amount : null,
  };
}

function boardValue(source, label) {
  const key = normalizeHeaderKey(label);
  const isAggregate = Array.isArray(source.skuIds);
  const hasOwn = (property) => Object.prototype.hasOwnProperty.call(source, property);
  const values = {
    '仓库': source.name || source.warehouse || source.warehouseGroup,
    'skuid': source.skuId || source.skuIds?.[0],
    '销售日期': source.date,
    '产品名称': source.displayName || source.name,
    '当天结算供价': source.settlementPrice || source.price,
    '实际入库数量': source.inboundQuantity,
    '产品实时销量': source.sales,
    '仓库类型': source.warehouseType,
    '云仓单价': source.cloudUnitPrice || source.price,
    '产品日销额': source.amount,
    '产品成本': source.productCost,
    '初始库存': source.openingStock,
    '当天剩余库存': source.dayEndStock || source.stock,
    '中心仓剩余': source.centerStock,
    '累计可用库存': source.availableStock || source.stock,
    '周转天数': source.turnoverDays,
    '前10天平均日销': source.tenDayAverageSales,
    '技术服务费': hasOwn('technicalServiceFee') ? source.technicalServiceFee : Number.isFinite(source.sales) ? source.sales * 0.165 : null,
    '多货费': source.overStockFee,
    '云仓费用': source.cloudWarehouseFee,
    '共享仓费用': source.sharedWarehouseFee,
    '其他仓储费': source.otherWarehouseFee,
    [STORAGE_FEE_LABEL]: source.totalStorageFee ?? sumFinite(
      source.technicalServiceFee,
      source.overStockFee,
      source.cloudWarehouseFee,
      source.sharedWarehouseFee,
      source.otherWarehouseFee
    ),
    '秒杀坑位费': source.flashSaleSlotFee,
    '扣点比例': source.deductionRate,
    '平台扣费': source.platformFee ?? (Number.isFinite(source.amount) ? source.amount * 0.04 : null),
    '售后费用': source.afterSalesFee ?? (Number.isFinite(source.sales) ? source.sales * 0.01 : null),
  };
  if (Object.prototype.hasOwnProperty.call(values, label)) return values[label];
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  if (isAggregate && key === '产品名称') return source.name;
  return source[key] ?? null;
}

function formatBoardValue(value, kind) {
  if (value == null || value === '') return '-';
  if (kind === 'money') return Number.isFinite(value) ? `￥${Number(value.toFixed(2))}` : String(value);
  if (kind === 'percent') return Number.isFinite(value) ? `${Number((value * 100).toFixed(2))}%` : String(value);
  if (kind === 'days') return Number.isFinite(value) ? `${Number(value.toFixed(1))}天` : String(value);
  if (kind === 'number') return Number.isFinite(value) ? Number(value.toFixed(1)) : String(value);
  return String(value);
}

function projectBoardRow(source, fields) {
  const cells = fields.map((field) => {
    const value = boardValue(source, field.label);
    return {
      ...field,
      value,
      display: formatBoardValue(value, field.kind),
    };
  });
  return {
    key: source.key || `${source.date || ''}:${source.skuId || source.name || ''}:${source.warehouse || ''}`,
    date: source.date || '',
    skuId: source.skuId || source.skuIds?.[0] || '',
    name: source.displayName || source.name || '',
    warehouse: source.warehouse || source.name || '',
    warehouseGroup: source.warehouseGroup || source.name || '',
    status: source.status || 'info',
    statusLabel: source.statusLabel || statusLabel(source.status),
    cells,
    values: Object.fromEntries(cells.map((cell) => [cell.label, cell.value])),
  };
}

function projectBoardRows(rows, fields) {
  return rows.map((row) => projectBoardRow(row, fields));
}

function reviewSheetTitle(date) {
  return `${REVIEW_SHEET_PREFIX}-${date}`;
}

function cellRawValue(cell) {
  if (cell.value == null) return '';
  return cell.value;
}

function boardSectionValues(title, board, leadingHeaders = []) {
  const fields = (board.fields || []).filter((field) => !leadingHeaders.includes(field.label));
  const headers = leadingHeaders.concat(fields.map((field) => field.label));
  const rows = (board.rows || []).map((row) => {
    const leading = leadingHeaders.map((header) => {
      if (header === '仓库') return row.warehouse || row.warehouseGroup || '';
      if (header === '状态') return row.statusLabel || '';
      if (header === 'SKUID') return row.skuId || '';
      if (header === '商品名称') return row.name || '';
      return row.values?.[header] ?? '';
    });
    return leading.concat(fields.map((field) => {
      const cell = (row.cells || []).find((item) => item.key === field.key);
      return cellRawValue(cell || {});
    }));
  });
  return [[title], headers, ...rows];
}

function buildReviewValuesForDay(day, refreshedAt) {
  const big = day.kanban?.big || { fields: [], rows: [] };
  const small = day.kanban?.small || { fields: [], rows: [] };
  const bigLeadingHeaders = ['仓库', '状态'];
  const smallLeadingHeaders = ['仓库', '状态'];
  return [
    ['看板复盘', day.date, '生成时间', refreshedAt],
    [],
    ...boardSectionValues('大看板（分仓库）', big, bigLeadingHeaders),
    [],
    ...boardSectionValues('小看板（分SKUID）', small, smallLeadingHeaders),
  ];
}

async function writeKanbanReviewSheets(payload, targetUrl, tenantToken, { force = false } = {}) {
  const writebackKey = `${targetUrl}\n${payload.refreshedAt}\n${payload.dates.join(',')}`;
  if (!force && lastWriteback?.targetUrl === targetUrl && Date.now() - lastWriteback.finishedAt < WRITEBACK_TTL_MS) {
    return {
      skipped: true,
      reason: 'recent-writeback',
      targetUrl,
      writtenDates: lastWriteback.writtenDates || [],
      finishedAt: new Date(lastWriteback.finishedAt).toISOString(),
    };
  }

  const resolved = await resolveSpreadsheet(targetUrl, tenantToken);
  const existingSheets = await listFeishuSheets(resolved.spreadsheetToken, tenantToken);
  const sheetMap = new Map(existingSheets.map((sheet) => [sheetTitle(sheet), sheetId(sheet)]));
  const written = [];

  for (const date of payload.dates) {
    const day = payload.days[date];
    if (!day) continue;
    const title = reviewSheetTitle(date);
    let id = sheetMap.get(title);
    if (!id) {
      id = await createFeishuSheet(resolved.spreadsheetToken, title, tenantToken);
      sheetMap.set(title, id);
    }
    const values = withBlankRows(buildReviewValuesForDay(day, payload.refreshedAt), 300);
    const result = await writeValuesToFeishu(resolved.spreadsheetToken, id, values, tenantToken);
    written.push({ date, title, range: result.range });
  }
  const sorted = await sortFeishuSheetsByDate(resolved.spreadsheetToken, tenantToken);

  lastWriteback = {
    writebackKey,
    targetUrl,
    writtenDates: written.map((item) => item.date),
    finishedAt: Date.now(),
  };

  return {
    skipped: false,
    targetUrl,
    writtenCount: written.length,
    written,
    sorted,
  };
}

function buildDailyPayload(rawRows, rules, boardFields) {
  const enriched = enrichRows(rawRows, rules);
  const dates = Array.from(new Set(enriched.map((row) => row.date).filter(Boolean))).sort();
  const days = {};
  dates.forEach((date) => {
    const rows = enriched.filter((row) => row.date === date);
    const warehouseRows = aggregateBy(
      rows,
      (row) => normalizeKey(row.warehouseGroup || row.warehouse || '未分仓库'),
      (row) => row.warehouseGroup || row.warehouse || '未分仓库'
    );
    const skuRows = aggregateBy(
      rows,
      (row) => normalizeKey(row.skuId || row.displayName),
      (row) => row.displayName || row.skuId || '未命名商品'
    ).map((row) => ({
      ...row,
      skuId: row.skuIds[0] || row.key,
    }));
    const warehouseSkuRows = [...rows].sort((a, b) => {
      if (a.status !== b.status) return ['bad', 'warn', 'info', 'ok'].indexOf(a.status) - ['bad', 'warn', 'info', 'ok'].indexOf(b.status);
      return a.safetyGap - b.safetyGap;
    });
    days[date] = {
      date,
      kpis: makeKpis(rows),
      warehouseRows,
      skuRows,
      warehouseSkuRows,
      kanban: {
        big: {
          groupBy: 'warehouse',
          fields: boardFields.big,
          rows: projectBoardRows(warehouseRows, boardFields.big),
        },
        small: {
          groupBy: 'skuId',
          fields: boardFields.small,
          rows: projectBoardRows(warehouseSkuRows, boardFields.small),
        },
      },
    };
  });
  return { dates, days };
}

export async function loadKanbanData({ forceRefresh = false } = {}) {
  const now = Date.now();
  const rawSourceUrl = process.env.FEISHU_KANBAN_RAW_URL || process.env.FEISHU_WIKI_URL || DEFAULT_RAW_SOURCE_URL;
  const rulesSourceUrl = process.env.FEISHU_KANBAN_RULES_URL || DEFAULT_RULES_SOURCE_URL;
  const reviewTargetUrl = process.env.FEISHU_KANBAN_REVIEW_URL || DEFAULT_REVIEW_TARGET_URL;
  const writebackEnabled = truthyEnv(process.env.FEISHU_KANBAN_WRITEBACK, true);
  const cacheKey = `${rawSourceUrl}\n${rulesSourceUrl}\n${reviewTargetUrl}\n${writebackEnabled}`;

  if (!forceRefresh && cachedPayload?.cacheKey === cacheKey && now - cachedPayload.loadedAt < CACHE_TTL_MS) {
    return { ...cachedPayload.payload, cache: { hit: true, loadedAt: cachedPayload.payload.refreshedAt } };
  }

  const tenantToken = await getTenantAccessToken();
  const warnings = [];
  const rawSpreadsheet = await readFeishuSpreadsheet(rawSourceUrl, tenantToken);
  const rawRows = parseRawRows(rawSpreadsheet);
  if (!rawRows.length) warnings.push('raw source 没有解析到可用的商品/仓库日数据。');

  let rulesSpreadsheet = null;
  let rules = [];
  let boardFields = defaultBoardFields();
  let boardRuleSourceSheet = '';
  try {
    rulesSpreadsheet = await readFeishuSpreadsheet(rulesSourceUrl, tenantToken);
    const boardRules = parseBoardFieldRules(rulesSpreadsheet);
    boardFields = { big: boardRules.big, small: boardRules.small };
    boardRuleSourceSheet = boardRules.sourceSheet;
    rules = parseRules(rulesSpreadsheet);
  } catch (error) {
    warnings.push(`kanban rules 读取失败，已按原始数据自动聚合：${error.message}`);
  }

  const daily = buildDailyPayload(rawRows, rules, boardFields);
  const payload = {
    ok: true,
    refreshedAt: new Date().toISOString(),
    source: {
      rawUrl: rawSourceUrl,
      rawSheetCount: rawSpreadsheet.sheetCount,
      rawRowCount: rawRows.length,
      rulesUrl: rulesSourceUrl,
      rulesSheetCount: rulesSpreadsheet?.sheetCount || 0,
      rulesRowCount: rules.length,
      reviewUrl: reviewTargetUrl,
      writebackEnabled,
      boardRuleSourceSheet,
      bigBoardFieldCount: boardFields.big.length,
      smallBoardFieldCount: boardFields.small.length,
    },
    rules: {
      bigBoardFields: boardFields.big,
      smallBoardFields: boardFields.small,
      matchRuleCount: rules.length,
    },
    warnings,
    dates: daily.dates,
    days: daily.days,
  };

  if (writebackEnabled) {
    try {
      payload.writeback = await writeKanbanReviewSheets(payload, reviewTargetUrl, tenantToken);
    } catch (error) {
      const message = friendlyFeishuError(error);
      payload.writeback = { skipped: false, targetUrl: reviewTargetUrl, error: message };
      payload.warnings.push(`看板复盘写入飞书失败：${message}`);
    }
  } else {
    payload.writeback = { skipped: true, reason: 'disabled', targetUrl: reviewTargetUrl };
  }

  cachedPayload = { cacheKey, loadedAt: now, payload };
  return { ...payload, cache: { hit: false, loadedAt: payload.refreshedAt } };
}

export const KANBAN_DEFAULTS = {
  rawSourceUrl: DEFAULT_RAW_SOURCE_URL,
  rulesSourceUrl: DEFAULT_RULES_SOURCE_URL,
  reviewTargetUrl: DEFAULT_REVIEW_TARGET_URL,
};
