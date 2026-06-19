import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BITABLE_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/KtSywi44qiHpchkPhWccxthqnHb';
const DEFAULT_RAW_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/EChawQEHEipllvkxqMycZL3Yn7c';
const DEFAULT_REVIEW_URL = 'https://xcn413dmlc7m.feishu.cn/wiki/H4QTwsAcJiUzZ5kaHr9cMJHpnCc';

const TABLE_NAMES = {
  board: '看板',
  review: '看板复盘大表',
  sales: '销售数据大表',
  monthIndex: '月份索引',
};

const TEXT = 1;
const NUMBER = 2;

async function loadDotEnv() {
  let text = '';
  try {
    text = await readFile(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function wikiToken(urlOrToken) {
  const text = normalizeText(urlOrToken);
  const match = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  return match ? match[1] : text;
}

function monthOf(date) {
  return String(date || '').slice(0, 7);
}

function displayNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function textValue(value) {
  return value == null ? '' : String(value);
}

function recordKey(parts) {
  return parts.map((part) => normalizeText(part).replace(/\|/g, '/')).join('|');
}

function compactFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function cellsToDetail(cells = []) {
  return cells
    .map((cell) => `${cell.label}: ${textValue(cell.display)}`)
    .join('；');
}

function cellNumber(cells = [], label) {
  const cell = cells.find((item) => item.label === label);
  return Number.isFinite(cell?.value) ? displayNumber(cell.value) : null;
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30000),
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
  if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET。');
  const body = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return body.tenant_access_token;
}

async function resolveWikiObject(urlOrToken, tenantToken) {
  const token = wikiToken(urlOrToken);
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?${new URLSearchParams({ token })}`,
    { headers: { Authorization: `Bearer ${tenantToken}` } }
  );
  const node = body.data?.node || body.data || {};
  const objectToken = node.obj_token || node.objToken;
  const objectType = node.obj_type || node.objType;
  if (!objectToken) throw new Error(`无法解析 wiki 节点：${urlOrToken}`);
  return { objectToken, objectType };
}

async function listTables(appToken, tenantToken) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    { headers: { Authorization: `Bearer ${tenantToken}` } }
  );
  return body.data?.items || [];
}

async function createTable(appToken, tenantToken, name, primaryFieldName) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        table: {
          name,
          default_view_name: '全部',
          fields: [{ field_name: primaryFieldName, type: TEXT }],
        },
      }),
    }
  );
  return { table_id: body.data?.table_id, name };
}

async function ensureTable(appToken, tenantToken, name, primaryFieldName) {
  const tables = await listTables(appToken, tenantToken);
  const existing = tables.find((table) => (table.name || table.table_name) === name);
  if (existing) return existing;
  return createTable(appToken, tenantToken, name, primaryFieldName);
}

async function listFields(appToken, tableId, tenantToken) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    { headers: { Authorization: `Bearer ${tenantToken}` } }
  );
  return body.data?.items || [];
}

async function createField(appToken, tableId, tenantToken, field) {
  await feishuJson(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(field),
    }
  );
}

async function ensureFields(appToken, table, tenantToken, fields) {
  const existingFields = await listFields(appToken, table.table_id, tenantToken);
  const existingNames = new Set(existingFields.map((field) => field.field_name));
  for (const field of fields) {
    if (existingNames.has(field.field_name)) continue;
    await createField(appToken, table.table_id, tenantToken, field);
  }
}

async function listRecords(appToken, tableId, tenantToken) {
  const records = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const body = await feishuJson(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query}`,
      { headers: { Authorization: `Bearer ${tenantToken}` } }
    );
    records.push(...(body.data?.items || []));
    pageToken = body.data?.page_token || '';
    if (!body.data?.has_more) break;
  } while (pageToken);
  return records;
}

async function deleteRecords(appToken, tableId, tenantToken, recordIds) {
  for (let index = 0; index < recordIds.length; index += 500) {
    const chunk = recordIds.slice(index, index + 500);
    if (!chunk.length) continue;
    await feishuJson(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ records: chunk }),
      }
    );
  }
}

async function createRecords(appToken, tableId, tenantToken, records) {
  for (let index = 0; index < records.length; index += 500) {
    const chunk = records.slice(index, index + 500);
    if (!chunk.length) continue;
    await feishuJson(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ records: chunk.map((fields) => ({ fields })) }),
      }
    );
  }
}

async function replaceTableRecords(appToken, table, tenantToken, fields) {
  const existing = await listRecords(appToken, table.table_id, tenantToken);
  await deleteRecords(appToken, table.table_id, tenantToken, existing.map((record) => record.record_id));
  await createRecords(appToken, table.table_id, tenantToken, fields);
  return { deleted: existing.length, inserted: fields.length };
}

function boardRecords(payload, syncedAt) {
  const records = [];
  for (const date of payload.dates || []) {
    const day = payload.days?.[date];
    const month = monthOf(date);
    for (const [boardType, board] of [
      ['大看板', day?.kanban?.big],
      ['小看板', day?.kanban?.small],
    ]) {
      for (const row of board?.rows || []) {
        records.push(compactFields({
          '记录ID': recordKey([date, boardType, row.key]),
          '月份': month,
          '日期': date,
          '看板类型': boardType,
          '仓库': textValue(row.warehouse || row.warehouseGroup),
          'SKUID': textValue(row.skuId),
          '商品名称': textValue(row.name),
          '状态': textValue(row.statusLabel || row.status),
          '指标': '行汇总',
          '数值': cellNumber(row.cells, '产品实时销量'),
          '展示值': cellsToDetail(row.cells),
          '销量': cellNumber(row.cells, '产品实时销量'),
          '日销额': cellNumber(row.cells, '产品日销额'),
          '总仓储费用': cellNumber(row.cells, '总仓储费用'),
          '剩余库存': cellNumber(row.cells, '当天剩余库存'),
          '累计可用库存': cellNumber(row.cells, '累计可用库存'),
          '周转天数': cellNumber(row.cells, '周转天数'),
          '同步时间': syncedAt,
        }));
      }
    }
  }
  return records;
}

function generatedReviewRecords(payload, syncedAt) {
  const records = [];
  for (const date of payload.dates || []) {
    const day = payload.days?.[date];
    const month = monthOf(date);
    for (const [section, board] of [
      ['大看板（分仓库）', day?.kanban?.big],
      ['小看板（分SKUID）', day?.kanban?.small],
    ]) {
      for (const row of board?.rows || []) {
        records.push(compactFields({
          '记录ID': recordKey([date, section, row.key]),
          '月份': month,
          '日期': date,
          '区块': section,
          '仓库': textValue(row.warehouse || row.warehouseGroup),
          '状态': textValue(row.statusLabel || row.status),
          'SKUID': textValue(row.skuId),
          '商品名称': textValue(row.name),
          '指标': '行汇总',
          '数值': cellNumber(row.cells, '产品实时销量'),
          '展示值': cellsToDetail(row.cells),
          '销量': cellNumber(row.cells, '产品实时销量'),
          '日销额': cellNumber(row.cells, '产品日销额'),
          '总仓储费用': cellNumber(row.cells, '总仓储费用'),
          '剩余库存': cellNumber(row.cells, '当天剩余库存'),
          '累计可用库存': cellNumber(row.cells, '累计可用库存'),
          '周转天数': cellNumber(row.cells, '周转天数'),
          '来源': 'kanban实时计算',
          '同步时间': syncedAt,
        }));
      }
    }
  }
  return records;
}

function salesRecords(payload, syncedAt) {
  const records = [];
  for (const date of payload.dates || []) {
    const day = payload.days?.[date];
    const month = monthOf(date);
    for (const row of day?.warehouseSkuRows || []) {
      records.push(compactFields({
        '记录ID': recordKey([date, row.warehouse, row.skuId || row.displayName]),
        '月份': month,
        '日期': date,
        '仓库': textValue(row.warehouse),
        '仓库分组': textValue(row.warehouseGroup),
        'SKUID': textValue(row.skuId),
        '商品名称': textValue(row.displayName || row.name),
        '销量': displayNumber(row.sales),
        '剩余库存': displayNumber(row.stock),
        '预估日销': displayNumber(row.expected),
        '实际均价': displayNumber(row.price),
        '日销额': displayNumber(row.amount),
        '状态': textValue(row.statusLabel || row.status),
        '同步时间': syncedAt,
      }));
    }
  }
  return records;
}

function monthIndexRecords(recordGroups, syncedAt) {
  const records = [];
  for (const [dataType, recordsForType] of Object.entries(recordGroups)) {
    const byMonth = new Map();
    for (const record of recordsForType) {
      const month = record['月份'];
      if (!month) continue;
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(record);
    }
    for (const [month, items] of [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const dates = [...new Set(items.map((item) => item['日期']).filter(Boolean))].sort();
      records.push(compactFields({
        '索引ID': recordKey([month, dataType]),
        '月份': month,
        '数据类型': dataType,
        '记录数': items.length,
        '日期范围': dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : month,
        '打开方式': `在「${dataType}」表按「月份=${month}」筛选查看明细`,
        '同步时间': syncedAt,
      }));
    }
  }
  return records;
}

async function main() {
  await loadDotEnv();
  process.env.FEISHU_KANBAN_WRITEBACK = 'false';

  const { loadKanbanData } = await import('../web/kanban-data.mjs');
  const tenantToken = await getTenantAccessToken();
  const bitableUrl = process.env.FEISHU_BITABLE_URL || DEFAULT_BITABLE_URL;
  const { objectToken: appToken, objectType } = await resolveWikiObject(bitableUrl, tenantToken);
  if (String(objectType).toLowerCase() !== 'bitable') {
    throw new Error(`目标不是多维表格：${bitableUrl}`);
  }

  process.env.FEISHU_KANBAN_RAW_URL ||= DEFAULT_RAW_URL;
  process.env.FEISHU_KANBAN_REVIEW_URL ||= DEFAULT_REVIEW_URL;
  const payload = await loadKanbanData({ forceRefresh: true });
  const syncedAt = new Date().toISOString();

  const board = boardRecords(payload, syncedAt);
  const review = generatedReviewRecords(payload, syncedAt);
  const sales = salesRecords(payload, syncedAt);
  const monthIndex = monthIndexRecords({
    [TABLE_NAMES.board]: board,
    [TABLE_NAMES.review]: review,
    [TABLE_NAMES.sales]: sales,
  }, syncedAt);

  const tables = {
    board: await ensureTable(appToken, tenantToken, TABLE_NAMES.board, '记录ID'),
    review: await ensureTable(appToken, tenantToken, TABLE_NAMES.review, '记录ID'),
    sales: await ensureTable(appToken, tenantToken, TABLE_NAMES.sales, '记录ID'),
    monthIndex: await ensureTable(appToken, tenantToken, TABLE_NAMES.monthIndex, '索引ID'),
  };

  await ensureFields(appToken, tables.board, tenantToken, [
    { field_name: '月份', type: TEXT },
    { field_name: '日期', type: TEXT },
    { field_name: '看板类型', type: TEXT },
    { field_name: '仓库', type: TEXT },
    { field_name: 'SKUID', type: TEXT },
    { field_name: '商品名称', type: TEXT },
    { field_name: '状态', type: TEXT },
    { field_name: '指标', type: TEXT },
    { field_name: '数值', type: NUMBER },
    { field_name: '展示值', type: TEXT },
    { field_name: '销量', type: NUMBER },
    { field_name: '日销额', type: NUMBER },
    { field_name: '总仓储费用', type: NUMBER },
    { field_name: '剩余库存', type: NUMBER },
    { field_name: '累计可用库存', type: NUMBER },
    { field_name: '周转天数', type: NUMBER },
    { field_name: '同步时间', type: TEXT },
  ]);
  await ensureFields(appToken, tables.review, tenantToken, [
    { field_name: '月份', type: TEXT },
    { field_name: '日期', type: TEXT },
    { field_name: '区块', type: TEXT },
    { field_name: '仓库', type: TEXT },
    { field_name: '状态', type: TEXT },
    { field_name: 'SKUID', type: TEXT },
    { field_name: '商品名称', type: TEXT },
    { field_name: '指标', type: TEXT },
    { field_name: '数值', type: NUMBER },
    { field_name: '展示值', type: TEXT },
    { field_name: '销量', type: NUMBER },
    { field_name: '日销额', type: NUMBER },
    { field_name: '总仓储费用', type: NUMBER },
    { field_name: '剩余库存', type: NUMBER },
    { field_name: '累计可用库存', type: NUMBER },
    { field_name: '周转天数', type: NUMBER },
    { field_name: '来源', type: TEXT },
    { field_name: '同步时间', type: TEXT },
  ]);
  await ensureFields(appToken, tables.sales, tenantToken, [
    { field_name: '月份', type: TEXT },
    { field_name: '日期', type: TEXT },
    { field_name: '仓库', type: TEXT },
    { field_name: '仓库分组', type: TEXT },
    { field_name: 'SKUID', type: TEXT },
    { field_name: '商品名称', type: TEXT },
    { field_name: '销量', type: NUMBER },
    { field_name: '剩余库存', type: NUMBER },
    { field_name: '预估日销', type: NUMBER },
    { field_name: '实际均价', type: NUMBER },
    { field_name: '日销额', type: NUMBER },
    { field_name: '状态', type: TEXT },
    { field_name: '同步时间', type: TEXT },
  ]);
  await ensureFields(appToken, tables.monthIndex, tenantToken, [
    { field_name: '月份', type: TEXT },
    { field_name: '数据类型', type: TEXT },
    { field_name: '记录数', type: NUMBER },
    { field_name: '日期范围', type: TEXT },
    { field_name: '打开方式', type: TEXT },
    { field_name: '同步时间', type: TEXT },
  ]);

  const results = {
    [TABLE_NAMES.board]: await replaceTableRecords(appToken, tables.board, tenantToken, board),
    [TABLE_NAMES.review]: await replaceTableRecords(appToken, tables.review, tenantToken, review),
    [TABLE_NAMES.sales]: await replaceTableRecords(appToken, tables.sales, tenantToken, sales),
    [TABLE_NAMES.monthIndex]: await replaceTableRecords(appToken, tables.monthIndex, tenantToken, monthIndex),
  };

  console.log(JSON.stringify({
    ok: true,
    bitableUrl,
    dates: { first: payload.dates?.[0], last: payload.dates?.[payload.dates.length - 1], count: payload.dates?.length || 0 },
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
