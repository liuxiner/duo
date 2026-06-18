import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeBlockingModals,
  getUniqueServicePage,
  installBlockingModalGuard,
  PDD_PAGE_SIZE,
  setPddPageSize,
} from './pdd-page-tools.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || APP_ROOT);
const REPORT_URL = 'https://mc.pinduoduo.com/ddmc-mms/order/management';
const DEFAULT_REPORT_CONFIG_PATH = 'data/report-config.json';
const REPORT_ROWS_PER_IMAGE = 8;
const REPORT_MAX_ATTEMPTS = 3;
const REPORT_RETRY_DELAY_MS = 2000;
let reportBrowser = null;
let reportContext = null;
const REQUIRED_COLUMNS = [
  '商品信息', '销售区域', '仓库信息', '委托属性', '销售日期', '销售规格',
  '仓库销售库存', '仓库总库存', '仓库预估总销售数',
];
const DEFAULT_REPORT_ITEMS = [
  { id: '1', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['06:00', '07:00', '08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
  { id: '2', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['12:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
  { id: '3', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
  { id: '4', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
  { id: '5', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
  { id: '6', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
];

async function loadDotEnv(file = '.env') {
  let text;
  try {
    text = await readFile(path.resolve(ROOT, file), 'utf8');
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

function envBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function config() {
  return {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    chatName: process.env.FEISHU_REPORT_CHAT_NAME || '多多数字管家群',
    mentionName: process.env.FEISHU_REPORT_MENTION_NAME || '鑫',
    chatId: process.env.FEISHU_REPORT_CHAT_ID || '',
    mentionOpenId: process.env.FEISHU_REPORT_MENTION_OPEN_ID || '',
    cdpUrl: process.env.PDD_CDP_URL || '',
    profileDir: path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile'),
    browserChannel: process.env.PDD_BROWSER_CHANNEL || '',
    chromiumSandbox: envBool(process.env.PDD_CHROMIUM_SANDBOX, true),
    headless: envBool(process.env.PDD_REPORT_HEADLESS, false),
    outputDir: path.resolve(ROOT, process.env.PDD_REPORT_OUTPUT_DIR || 'data/reports'),
    reportConfigPath: path.resolve(ROOT, process.env.PDD_REPORT_CONFIG_PATH || DEFAULT_REPORT_CONFIG_PATH),
  };
}

function beijingTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function fileTimestamp() {
  return beijingTimestamp().replace(/[ :]/g, '-');
}

function beijingTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function currentBeijingTime(date = new Date()) {
  const p = beijingTimeParts(date);
  return `${p.hour}:${p.minute}`;
}

function normalizeTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeTimeList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return [...new Set(values.map(normalizeTime).filter(Boolean))];
}

function defaultReportConfig() {
  return { schedulerEnabled: false, items: DEFAULT_REPORT_ITEMS.map(normalizeReportItem) };
}

function normalizeReportItem(item, index = 0) {
  const mentionNames = Array.isArray(item.mentionNames)
    ? item.mentionNames
    : String(item.mentionNames || item.mentionName || item['@群成员'] || item.memberName || '')
      .split(/[,，]/);
  return {
    id: String(item.id || item.index || item['序号'] || index + 1),
    region: item.region || item['区域'] || '',
    warehouse: item.warehouse || item['仓库'] || '',
    groupName: item.groupName || item['群名'] || '',
    chatName: item.chatName || item['发送群名'] || item.groupName || item['群名'] || '',
    memberName: item.memberName || item['成员名'] || '',
    mentionNames: mentionNames.flatMap((name) => String(name).split(/[,，]/)).map((name) => name.trim()).filter(Boolean),
    wechatEnabled: typeof item.wechatEnabled === 'boolean' ? item.wechatEnabled : Boolean(item.wechatRoomName),
    wechatRoomName: String(item.wechatRoomName || '').trim(),
    wechatMentionNames: Array.isArray(item.wechatMentionNames)
      ? item.wechatMentionNames.map((name) => String(name).trim()).filter(Boolean)
      : String(item.wechatMentionNames || '').split(/[,，]/).map((name) => name.trim()).filter(Boolean),
    sendTimes: normalizeTimeList(item.sendTimes || item['发送时间']),
    cutoffTime: normalizeTime(item.cutoffTime || item['截单时间']) || String(item.cutoffTime || item['截单时间'] || ''),
    topOfHour: typeof item.topOfHour === 'boolean' ? item.topOfHour : ['是', 'true', '1', 'yes'].includes(String(item.topOfHour || item['是否整点'] || '').toLowerCase()),
    enabled: typeof item.enabled === 'boolean' ? item.enabled : ['启', 'true', '1', 'yes', 'enable'].includes(String(item.enabled || item['状态(启/停)'] || item['状态'] || '').toLowerCase()),
  };
}

async function loadReportConfig(cfg) {
  let text;
  try {
    text = await readFile(cfg.reportConfigPath, 'utf8');
  } catch {
    return defaultReportConfig();
  }
  const trimmed = text.trim();
  if (!trimmed) return defaultReportConfig();
  const parsed = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : parsed.items || [];
  return {
    schedulerEnabled: Boolean(parsed.schedulerEnabled),
    items: items.map(normalizeReportItem),
  };
}

async function loadReportConfigs(cfg) {
  return (await loadReportConfig(cfg)).items;
}

function enabledReportConfigs(configs) {
  return configs.filter((item) => item.enabled);
}

function reportIsDue(item, { all = false, now = new Date(), ids = [] } = {}) {
  if (all) return true;
  if (ids.length) return ids.includes(item.id);
  return item.sendTimes.includes(currentBeijingTime(now));
}

function reportFilterKeywords(item) {
  const warehouse = String(item.warehouse || '').replace(/\s+/g, '').trim();
  if (!warehouse) return [];
  const keyword = warehouse.replace(/(?:仓库)?仓组$/, '').replace(/仓库$/, '');
  return [keyword || warehouse];
}

function mergeDuplicateReports(items) {
  const merged = new Map();
  for (const item of items) {
    const warehouseKey = reportFilterKeywords(item)[0] || String(item.warehouse || '').trim();
    const key = `${warehouseKey}::${String(item.chatName || '').trim()}::${String(item.wechatRoomName || '').trim()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...item,
        sourceIds: [item.id],
        mentionNames: [...item.mentionNames],
        wechatMentionNames: [...item.wechatMentionNames],
      });
      continue;
    }
    existing.sourceIds.push(item.id);
    existing.mentionNames = [...new Set([...existing.mentionNames, ...item.mentionNames])];
    existing.wechatMentionNames = [...new Set([...existing.wechatMentionNames, ...item.wechatMentionNames])];
  }
  return [...merged.values()];
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    const permissionUrl = String(body.msg || '').match(/https:\/\/open\.feishu\.cn\/app\/[^\s]+/)?.[0] || '';
    const scopes = (body.error?.permission_violations || [])
      .map((item) => item.subject)
      .filter(Boolean);
    const error = new Error(
      body.code === 99991672
        ? `飞书应用缺少权限：${scopes.join(' 或 ') || body.msg}`
        : `Feishu API failed: HTTP ${response.status} ${body.msg || JSON.stringify(body)}`
    );
    error.code = body.code;
    error.permissionUrl = permissionUrl;
    error.logId = body.error?.log_id || '';
    throw error;
  }
  return body;
}

function printRunError(error) {
  console.error(`上报失败：${error.message}`);
  if (error.permissionUrl) {
    console.error(`权限申请：${error.permissionUrl}`);
    console.error('开通权限后，请发布飞书应用新版本并完成企业管理员授权，然后重新运行。');
  }
  if (error.logId) console.error(`飞书日志 ID：${error.logId}`);
}

async function tenantToken(cfg) {
  if (!cfg.appId || !cfg.appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required.');
  const body = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  return body.tenant_access_token;
}

async function findChat(token, cfg, chatName = cfg.chatName) {
  if (cfg.chatId && chatName === cfg.chatName) return { chat_id: cfg.chatId, name: cfg.chatName };
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const body = await feishuJson(`https://open.feishu.cn/open-apis/im/v1/chats?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const matches = (body.data?.items || []).filter((chat) => chat.name === chatName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Found multiple Feishu chats named ${chatName}; set FEISHU_REPORT_CHAT_ID.`);
    pageToken = body.data?.has_more ? body.data.page_token : '';
  } while (pageToken);
  throw new Error(`Feishu bot is not in chat: ${chatName}`);
}

async function findMentionMember(token, chatId, cfg, mentionName = cfg.mentionName) {
  if (cfg.mentionOpenId && mentionName === cfg.mentionName) return { member_id: cfg.mentionOpenId, name: cfg.mentionName };
  let pageToken = '';
  const matches = [];
  do {
    const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const body = await feishuJson(
      `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?${query}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    matches.push(...(body.data?.items || []).filter((member) => member.name === mentionName));
    pageToken = body.data?.has_more ? body.data.page_token : '';
  } while (pageToken);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Found multiple members named ${mentionName}; set FEISHU_REPORT_MENTION_OPEN_ID.`);
  throw new Error(`Could not find member ${mentionName} in Feishu chat.`);
}

async function findMentionMembers(token, chatId, cfg, mentionNames = []) {
  const names = [...new Set((mentionNames.length ? mentionNames : [cfg.mentionName]).filter(Boolean))];
  const members = [];
  for (const name of names) {
    members.push(await findMentionMember(token, chatId, cfg, name));
  }
  return members;
}

async function waitForTable(page) {
  await closeBlockingModals(page);
  await page.locator('[data-testid="beast-core-table"]').first().waitFor({ timeout: 5 * 60 * 1000 });
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('[data-testid="beast-core-table"] tbody tr');
    const text = document.querySelector('[data-testid="beast-core-table"]')?.innerText || '';
    return rows.length > 0 && !/加载中/.test(text);
  }, null, { timeout: 5 * 60 * 1000 });
  await page.waitForTimeout(1000);
}

async function readReportTableState(page) {
  return page.evaluate(() => {
    const pagination = document.querySelector('[data-testid="beast-core-pagination"]');
    const totalText = pagination?.querySelector('[class*="PGT_totalText"]')?.textContent || '';
    const total = Number((totalText.match(/共有\s*(\d+)\s*条/) || [])[1]);
    const pageSizeInput = pagination?.querySelector('.PGT_sizeChanger_5-157-0 input[data-testid="beast-core-select-htmlInput"]');
    const pageSize = Number(pageSizeInput?.value || 0);
    const middleBody = document.querySelector('[data-testid="beast-core-table-middle-body"]');
    const visibleRows = middleBody?.querySelectorAll('tbody tr[data-testid="beast-core-table-body-tr"]').length || 0;
    const loading = /加载中/.test(document.querySelector('[data-testid="beast-core-table"]')?.innerText || '');
    return {
      total: Number.isFinite(total) ? total : 0,
      pageSize: Number.isFinite(pageSize) ? pageSize : 0,
      visibleRows,
      loading,
    };
  });
}

async function waitForReportTableState(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let last = { total: 0, pageSize: 0, visibleRows: 0, loading: true };
  while (Date.now() < deadline) {
    last = await readReportTableState(page);
    const expectedRows = last.total > 0 && last.pageSize > 0 ? Math.min(last.total, last.pageSize) : 0;
    if (!last.loading && expectedRows > 0 && last.visibleRows === expectedRows) {
      stableCount += 1;
      if (stableCount >= 2) return last;
    } else {
      stableCount = 0;
    }
    await page.waitForTimeout(750);
  }
  throw new Error(
    `等待仓库数据加载超时：分页器共 ${last.total || 0} 条，每页 ${last.pageSize || 0} 条，实际加载 ${last.visibleRows || 0} 条。`
  );
}

async function selectWarehouseFilter(page, reportItem) {
  const keywords = reportFilterKeywords(reportItem);
  if (!keywords.length) throw new Error(`规则 #${reportItem.id} 未配置仓库。`);

  await closeBlockingModals(page);
  const formItem = page.locator('#warehouseId');
  await formItem.waitFor({ state: 'visible', timeout: 5 * 60 * 1000 });
  const header = formItem.locator('[data-testid="beast-core-select-header"]').first();
  const getDropdown = async () => {
    await closeBlockingModals(page);
    let dropdown = page.locator('[data-testid="beast-core-portal"]:visible')
      .filter({ has: page.locator('li[role="option"]') })
      .last();
    if (!(await dropdown.count().catch(() => 0))) {
      await header.click();
      dropdown = page.locator('[data-testid="beast-core-portal"]:visible')
        .filter({ has: page.locator('li[role="option"]') })
        .last();
    }
    await dropdown.waitFor({ state: 'visible', timeout: 10000 });
    return dropdown;
  };

  let dropdown = await getDropdown();
  const available = (await dropdown.locator('li[role="option"]').allInnerTexts())
    .map((label) => String(label).replace(/\s+/g, '').trim())
    .filter((label) => label && label !== '全选');
  const matched = available.filter((label) => keywords.some((keyword) => label.includes(keyword)));
  if (!matched.length) {
    throw new Error(`仓库下拉中没有匹配 ${keywords.join(', ')}；可选项：${available.join(', ')}`);
  }

  for (const label of matched) {
    let selected = false;
    for (let attempt = 1; attempt <= 3 && !selected; attempt += 1) {
      try {
        dropdown = await getDropdown();
        const option = dropdown.locator('li[role="option"]')
          .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) })
          .first();
        await option.waitFor({ state: 'visible', timeout: 5000 });
        if (await option.getAttribute('data-checked') !== 'true') {
          await option.click({ timeout: 5000 });
        }
        selected = true;
      } catch (error) {
        await closeBlockingModals(page).catch(() => {});
        if (attempt === 3) throw new Error(`选择仓库“${label}”失败：${error.message}`);
        await page.waitForTimeout(300);
      }
    }
  }

  await page.keyboard.press('Escape');
  await page.locator('[data-testid="beast-core-portal"]:visible')
    .filter({ has: page.locator('li[role="option"]') })
    .last().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  const previousTableText = await page.locator('[data-testid="beast-core-table"]').first()
    .innerText({ timeout: 3000 }).catch(() => '');
  const queryButton = page.locator('button').filter({ hasText: /^查询$/ }).first();
  await queryButton.click();
  await page.waitForTimeout(750);
  await page.waitForFunction((previous) => {
    const table = document.querySelector('[data-testid="beast-core-table"]');
    const pagination = document.querySelector('[data-testid="beast-core-pagination"]');
    const total = pagination?.querySelector('[class*="PGT_totalText"]')?.textContent || '';
    const text = table?.innerText || '';
    return Boolean(table && /共有\s*\d+\s*条/.test(total) && !/加载中/.test(text) && (!previous || text !== previous));
  }, previousTableText, { timeout: 30000 }).catch(() => {});

  let state = await waitForReportTableState(page);
  if (state.total === 0) throw new Error('仓库查询完成，共有 0 条数据。');
  await setPddPageSize(page, PDD_PAGE_SIZE);
  state = await waitForReportTableState(page);
  if (state.total > PDD_PAGE_SIZE) {
    throw new Error(`查询共有 ${state.total} 条，超过每页 ${PDD_PAGE_SIZE} 条，无法一次完整上报。`);
  }
  if (state.visibleRows !== state.total) {
    throw new Error(`数据校验失败：分页器共有 ${state.total} 条，实际抓取 ${state.visibleRows} 条。`);
  }
  console.log(`已选择仓库：${matched.join(', ')}。共有 ${state.total} 条，实际抓取 ${state.visibleRows} 条。`);
  return state;
}

async function prepareReportTable(page) {
  await closeBlockingModals(page);
  const result = await page.evaluate((requiredColumns) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('[data-testid="beast-core-table"] table, table'));
    let kept = 0;
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th'));
      if (!headers.length) continue;
      const keepIndexes = new Set();
      headers.forEach((header, index) => {
        const name = normalize(header.textContent);
        if (requiredColumns.includes(name)) {
          keepIndexes.add(index);
          kept += 1;
        }
      });
      if (!keepIndexes.size) {
        table.style.display = 'none';
        continue;
      }
      for (const row of table.querySelectorAll('tr')) {
        Array.from(row.children).forEach((cell, index) => {
          if (!keepIndexes.has(index)) cell.style.display = 'none';
        });
      }
    }
    document.querySelectorAll('[class*="pagination"], [data-testid*="pagination"]').forEach((node) => {
      node.style.display = 'none';
    });
    const root = document.querySelector('[data-testid="beast-core-table"]');
    if (root) {
      root.style.width = 'max-content';
      root.style.maxWidth = 'none';
      root.style.overflow = 'visible';
      root.style.height = 'auto';
      root.style.maxHeight = 'none';
    }
    root?.querySelectorAll('*').forEach((node) => {
      const style = getComputedStyle(node);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') {
        node.style.overflowX = 'visible';
        node.style.maxWidth = 'none';
      }
      if (
        node.matches('[data-testid$="-body"], [class*="TB_body"], [class*="TB_scrollXY"]')
        || style.overflowY === 'auto'
        || style.overflowY === 'scroll'
        || style.overflowY === 'hidden'
      ) {
        node.style.height = 'auto';
        node.style.maxHeight = 'none';
        node.style.overflowY = 'visible';
      }
    });
    return { kept };
  }, REQUIRED_COLUMNS);
  if (!result.kept) throw new Error('Could not find any required report columns in the PDD table.');
}

async function collectReplenishmentWarnings(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const parseQuantity = (value) => {
      const match = normalize(value).match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    };
    const header = document.querySelector('[data-testid="beast-core-table-middle-header"]');
    const body = document.querySelector('[data-testid="beast-core-table-middle-body"]');
    const headers = Array.from(header?.querySelectorAll('th') || []).map((cell) => normalize(cell.textContent));
    const productIndex = headers.indexOf('商品信息');
    const warehouseIndex = headers.indexOf('仓库信息');
    const stockIndex = headers.indexOf('仓库总库存');
    const estimateIndex = headers.indexOf('仓库预估总销售数');
    if ([productIndex, warehouseIndex, stockIndex, estimateIndex].some((index) => index < 0)) return [];

    return Array.from(body?.querySelectorAll('tbody tr[data-testid="beast-core-table-body-tr"]') || [])
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const productText = normalize(cells[productIndex]?.textContent);
        const productName = productText.replace(/\s*ID[:：]?\s*\d+.*$/i, '').trim() || productText;
        const warehouse = normalize(cells[warehouseIndex]?.textContent).replace(/查看地址/g, '').trim();
        const stock = parseQuantity(cells[stockIndex]?.textContent);
        const estimatedSales = parseQuantity(cells[estimateIndex]?.textContent);
        if (!Number.isFinite(stock) || !Number.isFinite(estimatedSales)) return null;
        const safetyStock = estimatedSales * 0.8;
        if (stock >= safetyStock) return null;
        return { productName, warehouse, stock, estimatedSales, safetyStock };
      })
      .filter(Boolean);
  });
}

async function showReportRowChunk(page, start, end) {
  const clip = await page.evaluate(({ requiredColumns, start, end }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('[data-testid="beast-core-table"]');
    const tables = Array.from(root?.querySelectorAll('table') || []);
    for (const table of tables) {
      if (getComputedStyle(table).display === 'none') continue;
      Array.from(table.querySelectorAll('tbody tr')).forEach((row, index) => {
        row.style.display = index >= start && index < end ? '' : 'none';
      });
    }
    const requiredHeaders = Array.from(root?.querySelectorAll('thead th') || [])
      .filter((header) => requiredColumns.includes(normalize(header.textContent)));
    const rootRect = root?.getBoundingClientRect();
    const right = Math.max(...requiredHeaders.map((header) => header.getBoundingClientRect().right));
    return rootRect && Number.isFinite(right) ? {
      x: Math.max(0, rootRect.left),
      y: Math.max(0, rootRect.top),
      width: Math.ceil(right - rootRect.left),
      height: Math.ceil(rootRect.height),
    } : null;
  }, { requiredColumns: REQUIRED_COLUMNS, start, end });
  if (!clip || clip.width <= 0 || clip.height <= 0) {
    throw new Error(`无法确定第 ${Math.floor(start / REPORT_ROWS_PER_IMAGE) + 1} 张截图范围。`);
  }
  return clip;
}

async function captureScreenshot(cfg, reportItem = null) {
  const { chromium } = await import('playwright');
  if (cfg.cdpUrl) {
    if (!reportBrowser?.isConnected() || !reportContext) {
      reportBrowser = await chromium.connectOverCDP(cfg.cdpUrl);
      reportContext = reportBrowser.contexts()[0];
      if (!reportContext) throw new Error(`No browser context found at ${cfg.cdpUrl}.`);
    }
  } else if (!reportContext) {
    reportContext = await chromium.launchPersistentContext(cfg.profileDir, {
      headless: cfg.headless,
      channel: cfg.browserChannel || undefined,
      chromiumSandbox: cfg.chromiumSandbox,
      viewport: { width: 2560, height: 1440 },
      locale: 'zh-CN',
    });
  }
  const page = await getUniqueServicePage(reportContext, REPORT_URL);
  try {
    await installBlockingModalGuard(page);
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await closeBlockingModals(page);
    console.log('Waiting for PDD order page/login verification...');
    let tableState;
    if (reportItem) {
      tableState = await selectWarehouseFilter(page, reportItem);
    } else {
      await waitForTable(page);
      await setPddPageSize(page, PDD_PAGE_SIZE);
      tableState = await waitForReportTableState(page);
      if (tableState.total > PDD_PAGE_SIZE || tableState.visibleRows !== tableState.total) {
        throw new Error(`数据校验失败：分页器共有 ${tableState.total} 条，实际抓取 ${tableState.visibleRows} 条。`);
      }
    }
    const warnings = await collectReplenishmentWarnings(page);
    console.log(`紧急补货预警：${warnings.length} 项。`);
    await prepareReportTable(page);
    await closeBlockingModals(page);
    await mkdir(cfg.outputDir, { recursive: true });
    const suffix = reportItem ? `-${reportItem.id}-${(reportItem.warehouse || reportItem.groupName || reportItem.chatName).replace(/[\\/:*?"<>|\s]+/g, '_')}` : '';
    const stamp = fileTimestamp();
    const partCount = Math.ceil(tableState.total / REPORT_ROWS_PER_IMAGE);
    const outputs = [];
    for (let part = 0; part < partCount; part += 1) {
      const start = part * REPORT_ROWS_PER_IMAGE;
      const end = Math.min(start + REPORT_ROWS_PER_IMAGE, tableState.total);
      const clip = await showReportRowChunk(page, start, end);
      const partSuffix = partCount > 1 ? `-part-${part + 1}-of-${partCount}` : '';
      const output = path.join(cfg.outputDir, `pdd-order-report-${stamp}${suffix}${partSuffix}.png`);
      await page.screenshot({ path: output, clip, animations: 'disabled' });
      outputs.push(output);
    }
    return { screenshots: outputs, warnings, total: tableState.total };
  } finally {
    await page.bringToFront().catch(() => {});
  }
}

async function uploadImage(token, file) {
  const bytes = await readFile(file);
  const form = new FormData();
  form.set('image_type', 'message');
  form.set('image', new Blob([bytes], { type: 'image/png' }), path.basename(file));
  const body = await feishuJson('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return body.data?.image_key;
}

async function sendReport(token, chatId, members, imageKeys, warnings = [], reportItem = null) {
  const titleParts = ['多多订单管理上报'];
  if (reportItem?.warehouse) titleParts.push(reportItem.warehouse);
  if (reportItem?.groupName && reportItem.groupName !== reportItem.warehouse) titleParts.push(reportItem.groupName);
  if (reportItem?.cutoffTime) titleParts.push(`截单 ${reportItem.cutoffTime}`);
  const mentionNodes = (Array.isArray(members) ? members : [members]).flatMap((member) => [
    { tag: 'at', user_id: member.member_id, user_name: member.name },
    { tag: 'text', text: ' ' },
  ]);
  const warningRows = warnings.length
    ? [
      [{ tag: 'text', text: `⚠️ 紧急补货预警（${warnings.length} 项）：仓库总库存低于仓库预估总销售数的 80%` }],
      ...warnings.map((warning) => [{
        tag: 'text',
        text: `⚠️ ${warning.productName}｜${warning.warehouse}｜库存 ${warning.stock}｜预估 ${warning.estimatedSales}｜80%安全线 ${Number(warning.safetyStock.toFixed(2))}`,
      }]),
    ]
    : [[{ tag: 'text', text: '暂无紧急补货预警' }]];
  const content = {
    zh_cn: {
      title: titleParts.join(' - '),
      content: [
        [
          ...mentionNodes,
          { tag: 'text', text: ` ${beijingTimestamp()} 数据截图，共 ${imageKeys.length} 张` },
        ],
        ...warningRows,
        ...imageKeys.map((imageKey) => [{ tag: 'img', image_key: imageKey }]),
      ],
    },
  };
  return feishuJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'post', content: JSON.stringify(content) }),
  });
}

async function runLegacyReport(cfg, token, { dryRun = false } = {}) {
  const chat = await findChat(token, cfg);
  const members = await findMentionMembers(token, chat.chat_id, cfg);
  console.log(`Resolved Feishu target: ${chat.name} (${chat.chat_id}), mention ${members.map((member) => member.name).join(', ')}.`);
  const report = await captureScreenshot(cfg);
  console.log(`Saved screenshots: ${report.screenshots.join(', ')}`);
  if (dryRun) return;
  const imageKeys = [];
  for (const screenshot of report.screenshots) imageKeys.push(await uploadImage(token, screenshot));
  await sendReport(token, chat.chat_id, members, imageKeys, report.warnings);
  console.log(`Sent hourly PDD report to ${chat.name}.`);
}

function formatWechatText(reportItem, warnings, total, imageCount, timestamp) {
  const parts = [];
  const titleParts = ['多多订单管理上报'];
  if (reportItem?.warehouse) titleParts.push(reportItem.warehouse);
  if (reportItem?.groupName && reportItem.groupName !== reportItem.warehouse) titleParts.push(reportItem.groupName);
  if (reportItem?.cutoffTime) titleParts.push(`截单 ${reportItem.cutoffTime}`);
  parts.push(titleParts.join(' - '));
  parts.push(`${timestamp} 数据截图，共 ${imageCount} 张，总计 ${total} 条商品`);

  if (warnings.length > 0) {
    parts.push(`\n紧急补货预警（${warnings.length} 项）：仓库总库存低于预估总销售数的 80%`);
    for (const w of warnings) {
      parts.push(`- ${w.productName}｜${w.warehouse}｜库存 ${w.stock}｜预估 ${w.estimatedSales}｜80%安全线 ${Number(w.safetyStock.toFixed(2))}`);
    }
  } else {
    parts.push('\n暂无紧急补货预警');
  }
  return parts.join('\n');
}

async function sendToWechat(reportItem, text, imagePaths) {
  if (!reportItem.wechatRoomName) return false;

  const bridgeUrl = process.env.WECHAT_BRIDGE_URL || 'http://127.0.0.1:4173';
  const mentionNames = reportItem.wechatMentionNames || [];
  console.log(
    `准备发送到微信群 ${reportItem.wechatRoomName}：${imagePaths.length} 张图片`
    + `${mentionNames.length ? `，@${mentionNames.join(', ')}` : '，不@人'}。`
  );
  console.log(`微信桥接服务：${bridgeUrl}`);
  const response = await fetch(`${bridgeUrl}/api/wechat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName: reportItem.wechatRoomName,
      text,
      imagePaths,
      mentionNames,
    }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`WeChat send failed: ${body.error || response.statusText}`);
    error.code = 'WECHAT_SEND_FAILED';
    throw error;
  }

  const sent = body.result || {};
  console.log(
    `已发送到微信群 ${sent.roomName || reportItem.wechatRoomName}：`
    + `${sent.imageCount ?? imagePaths.length} 张图片`
    + `${(sent.mentionNames || mentionNames).length ? `，已@${(sent.mentionNames || mentionNames).join(', ')}` : '，未@人'}。`
  );
  return true;
}

async function runConfiguredReports(cfg, token, configs, {
  dryRun = false,
  all = false,
  ids = [],
  channel = 'both',
} = {}) {
  const active = enabledReportConfigs(configs);
  const due = mergeDuplicateReports(active.filter((item) => reportIsDue(item, { all, ids })));
  if (!due.length) {
    console.log(`当前 ${currentBeijingTime()} 没有需要上报的启用规则。`);
    return;
  }
  if (channel === 'wechat') {
    const invalid = due.filter((item) => !item.wechatEnabled || !item.wechatRoomName);
    if (invalid.length) {
      const labels = invalid.map((item) => `#${item.id} ${item.warehouse || item.groupName}`);
      throw new Error(`以下规则未启用微信上报或未配置微信群名：${labels.join('、')}`);
    }
  }

  console.log(`本轮共有 ${due.length} 个仓库上报任务，按顺序排队执行。`);
  const failures = [];
  for (let queueIndex = 0; queueIndex < due.length; queueIndex += 1) {
    const item = due[queueIndex];
    const ruleLabel = item.sourceIds.map((id) => `#${id}`).join(', ');
    if (item.sourceIds.length > 1) console.log(`合并重复上报规则 ${ruleLabel}，本轮只发送一次。`);
    const targets = [];
    if (channel !== 'wechat') targets.push(`飞书 ${item.chatName}`);
    if (channel !== 'feishu' && item.wechatEnabled && item.wechatRoomName) targets.push(`微信 ${item.wechatRoomName}`);
    console.log(`队列 ${queueIndex + 1}/${due.length}：${item.warehouse || item.groupName} -> ${targets.join('、') || '未配置目标群'}.`);
    let completed = false;
    let lastError;
    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS && !completed; attempt += 1) {
      try {
        console.log(`开始上报规则 ${ruleLabel}（第 ${attempt}/${REPORT_MAX_ATTEMPTS} 次）：@${item.mentionNames.join(', ')}.`);
        const sendFeishu = channel !== 'wechat';
        const sendWechat = channel !== 'feishu' && item.wechatEnabled && item.wechatRoomName;
        const chat = !sendFeishu || dryRun
          ? { name: item.chatName, chat_id: '' }
          : await findChat(token, cfg, item.chatName);
        const members = !sendFeishu || dryRun
          ? item.mentionNames.map((name) => ({ name, member_id: '' }))
          : await findMentionMembers(token, chat.chat_id, cfg, item.mentionNames);
        const report = await captureScreenshot(cfg, item);
        console.log(`截图已生成（${report.screenshots.length} 张）：${report.screenshots.join(', ')}`);
        if (!dryRun && sendFeishu) {
          const imageKeys = [];
          for (const screenshot of report.screenshots) imageKeys.push(await uploadImage(token, screenshot));
          await sendReport(token, chat.chat_id, members, imageKeys, report.warnings, item);
          console.log(`规则 #${item.id} 已发送到飞书 ${chat.name}.`);
        }
        // WeChat send (if configured)
        if (!dryRun && sendWechat) {
          const wechatText = formatWechatText(item, report.warnings, report.total, report.screenshots.length, beijingTimestamp());
          await sendToWechat(item, wechatText, report.screenshots);
        } else if (dryRun && sendWechat) {
          console.log(`微信预览模式：不会发送到微信群；目标 ${item.wechatRoomName}，@${item.wechatMentionNames.join(', ') || '无'}。`);
        }
        completed = true;
      } catch (error) {
        lastError = error;
        console.error(`规则 ${ruleLabel} 第 ${attempt} 次失败：${error.message}`);
        if (error.code === 'WECHAT_SEND_FAILED') {
          console.error(`规则 ${ruleLabel} 微信发送失败，不自动重试，避免重复发送。`);
          break;
        }
        if (attempt < REPORT_MAX_ATTEMPTS) {
          console.log(`${REPORT_RETRY_DELAY_MS / 1000} 秒后重试规则 ${ruleLabel}。`);
          await new Promise((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS));
        }
      }
    }
    if (!completed) {
      failures.push(`${ruleLabel} ${item.warehouse || item.groupName}: ${lastError?.message || '未知错误'}`);
      console.error(`规则 ${ruleLabel} 已达到最大重试次数，继续下一个仓库。`);
    }
  }
  if (failures.length) {
    throw new Error(`本轮 ${due.length} 个任务完成，${failures.length} 个最终失败：${failures.join('；')}`);
  }
  console.log(`本轮 ${due.length} 个仓库上报任务全部完成。`);
}

async function runOnce({ dryRun = false, all = false, ids = [], channel = 'both' } = {}) {
  const cfg = config();
  const token = dryRun || channel === 'wechat' ? null : await tenantToken(cfg);
  const reportConfigs = await loadReportConfigs(cfg);
  if (reportConfigs.length) {
    await runConfiguredReports(cfg, token, reportConfigs, { dryRun, all, ids, channel });
  } else if (dryRun) {
    const report = await captureScreenshot(cfg);
    console.log(`Saved screenshots: ${report.screenshots.join(', ')}`);
  } else {
    await runLegacyReport(cfg, token, { dryRun });
  }
}

function msUntilNextMinute() {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next.getTime() - now.getTime();
}

async function scheduler() {
  const cfg = config();
  console.log('多多数字管家定时上报已启动，每分钟检查一次启用规则。');
  while (true) {
    const delay = msUntilNextMinute();
    await new Promise((resolve) => setTimeout(resolve, delay));
    const reportConfig = await loadReportConfig(cfg).catch((error) => {
      console.error(`读取上报配置失败：${error.message}`);
      return defaultReportConfig();
    });
    if (!reportConfig.schedulerEnabled) {
      console.log(`${currentBeijingTime()} 定时上报未开启。`);
      continue;
    }
    await runOnce().catch(printRunError);
  }
}

await loadDotEnv();
const args = new Set(process.argv.slice(2));
const idsArg = process.argv.slice(2).find((arg) => arg.startsWith('--ids='));
const ids = idsArg ? idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean) : [];
const channelArg = process.argv.slice(2).find((arg) => arg.startsWith('--channel='));
const requestedChannel = channelArg ? channelArg.slice('--channel='.length) : 'both';
const channel = ['both', 'feishu', 'wechat'].includes(requestedChannel) ? requestedChannel : 'both';
if (args.has('--once') || args.has('--dry-run')) {
  let exitCode = 0;
  await runOnce({ dryRun: args.has('--dry-run'), all: args.has('--all'), ids, channel }).catch((error) => {
    printRunError(error);
    exitCode = 1;
  });
  process.exit(exitCode);
} else {
  await scheduler();
}
