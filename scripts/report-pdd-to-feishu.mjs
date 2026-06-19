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
import { pddStorageStatePath, savePddStorageState } from './pdd-api-client.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || APP_ROOT);
const REPORT_URL = 'https://mc.pinduoduo.com/ddmc-mms/order/management';
const DEFAULT_REPORT_CONFIG_PATH = 'data/report-config.json';
const REPORT_MAX_ATTEMPTS = 3;
const REPORT_RETRY_DELAY_MS = 2000;
let reportBrowser = null;
let reportContext = null;
const DEFAULT_NOTIFICATION_CONFIG = {
  adminGroup: '杭州交仓',
  senderStrategy: 'desktop_wechat',
  sendIntervalSeconds: { min: 2, max: 5 },
  maxRetries: REPORT_MAX_ATTEMPTS - 1,
  retryDelaySeconds: REPORT_RETRY_DELAY_MS / 1000,
};
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
    storageStatePath: pddStorageStatePath(ROOT),
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

function compactReportTimestamp(date = new Date()) {
  const p = beijingTimeParts(date);
  return `${p.year.slice(-2)}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
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
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(/[,\s，、-]+/));
  return [...new Set(values.map(normalizeTime).filter(Boolean))];
}

function positiveInteger(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.round(next) : fallback;
}

function enabledConfigValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return ['1', 'true', 'yes', 'y', 'on', '启', '启动', '启用', 'enable', 'enabled'].includes(text);
}

function normalizeNotificationConfig(input = {}) {
  const defaults = DEFAULT_NOTIFICATION_CONFIG;
  const min = positiveInteger(input.sendIntervalSeconds?.min ?? input.sendIntervalMin, defaults.sendIntervalSeconds.min);
  const max = positiveInteger(input.sendIntervalSeconds?.max ?? input.sendIntervalMax, defaults.sendIntervalSeconds.max);
  return {
    adminGroup: String(input.adminGroup || defaults.adminGroup).trim(),
    senderStrategy: String(input.senderStrategy || defaults.senderStrategy).trim(),
    sendIntervalSeconds: {
      min: Math.min(min, max),
      max: Math.max(min, max),
    },
    maxRetries: positiveInteger(input.maxRetries, defaults.maxRetries),
    retryDelaySeconds: positiveInteger(input.retryDelaySeconds, defaults.retryDelaySeconds),
  };
}

function randomSendDelayMs(notification) {
  const interval = notification?.sendIntervalSeconds || DEFAULT_NOTIFICATION_CONFIG.sendIntervalSeconds;
  const min = Math.max(0, Number(interval.min || 0));
  const max = Math.max(min, Number(interval.max || min));
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function formatQuantity(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.?0+$/, '');
}

function defaultReportConfig() {
  return {
    schedulerEnabled: false,
    notification: normalizeNotificationConfig(),
    items: DEFAULT_REPORT_ITEMS.map(normalizeReportItem),
  };
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
    topOfHour: enabledConfigValue(item.topOfHour ?? item['是否整点'], false),
    enabled: enabledConfigValue(item.enabled ?? item['状态(启/停)'] ?? item['状态'], false),
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
    notification: normalizeNotificationConfig(parsed.notification || {}),
    items: items.map(normalizeReportItem),
  };
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
        const safetyStock = estimatedSales;
        if (stock >= safetyStock) return null;
        const replenishment = safetyStock - stock;
        const regionIndex = headers.indexOf('销售区域');
        const region = regionIndex >= 0 ? normalize(cells[regionIndex]?.textContent) : '';
        return { productName, region, warehouse, stock, estimatedSales, safetyStock, replenishment };
      })
      .filter(Boolean);
  });
}

async function renderCompactReport(page, { reportItem = null, timestamp = compactReportTimestamp() } = {}) {
  const result = await page.evaluate(({ reportItem, timestamp }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeHeader = (value) => normalize(value)
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/\s+/g, '');
    const parseQuantity = (value) => {
      const match = normalize(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    };
    const formatQuantityText = (value) => {
      if (!Number.isFinite(value)) return '0';
      const rounded = Math.round(value * 100) / 100;
      return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.?0+$/, '');
    };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
    const cellText = (cells, index) => index >= 0 ? normalize(cells[index]?.innerText || cells[index]?.textContent) : '';
    const findIndex = (headers, names) => {
      const targets = names.map(normalizeHeader);
      return headers.findIndex((header) => targets.some((target) => header === target || header.includes(target)));
    };
    const root = document.querySelector('[data-testid="beast-core-table"]');
    const header = root?.querySelector('[data-testid="beast-core-table-middle-header"]')
      || root?.querySelector('thead');
    const body = root?.querySelector('[data-testid="beast-core-table-middle-body"]')
      || root?.querySelector('tbody');
    const headers = Array.from(header?.querySelectorAll('th') || []).map((cell) => normalizeHeader(cell.textContent));
    const indexes = {
      product: findIndex(headers, ['商品信息']),
      region: findIndex(headers, ['销售区域']),
      warehouse: findIndex(headers, ['仓库信息', '所属仓库']),
      spec: findIndex(headers, ['销售规格', '规格']),
      sales: findIndex(headers, ['仓库总销售数', '销售数(份)', '销售数（份）', '实时销量']),
      estimate: findIndex(headers, ['仓库预估总销售数', '预计缺单销量', '预估销量']),
      stock: findIndex(headers, ['仓库总库存', '实际入库量', '仓库剩余量']),
      diff: findIndex(headers, ['仓库分拣差异量', '分拣差异量']),
    };
    const missing = [
      ['商品信息', indexes.product],
      ['仓库信息', indexes.warehouse],
      ['仓库预估总销售数', indexes.estimate],
      ['仓库总库存', indexes.stock],
    ].filter(([, index]) => index < 0).map(([label]) => label);
    if (missing.length) return { error: `截图表格缺少必要列：${missing.join(', ')}` };

    const sourceRows = Array.from(body?.querySelectorAll('tbody tr[data-testid="beast-core-table-body-tr"], tr[data-testid="beast-core-table-body-tr"], tbody tr, tr') || []);
    const rows = sourceRows.map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      const productCell = cells[indexes.product];
      const productText = cellText(cells, indexes.product);
      const idMatch = productText.match(/ID[:：]?\s*(\d+)/i);
      const productId = idMatch?.[1] || '';
      const productName = productText
        .replace(/ID[:：]?\s*\d+/ig, '')
        .replace(/查看详情|复制/ig, '')
        .trim() || productText;
      const region = cellText(cells, indexes.region);
      const warehouse = cellText(cells, indexes.warehouse).replace(/查看地址/g, '').replace(/\s+/g, '');
      const spec = cellText(cells, indexes.spec) || '-';
      const sales = parseQuantity(cellText(cells, indexes.sales));
      const estimate = parseQuantity(cellText(cells, indexes.estimate));
      const stock = parseQuantity(cellText(cells, indexes.stock));
      const diff = parseQuantity(cellText(cells, indexes.diff));
      const shortage = Number.isFinite(estimate) && Number.isFinite(stock) ? Math.max(0, estimate - stock) : 0;
      const image = productCell?.querySelector('img')?.currentSrc || productCell?.querySelector('img')?.src || '';
      return {
        productId,
        productName,
        image,
        region,
        warehouse,
        spec,
        sales,
        estimate,
        shortage,
        stock,
        diff,
      };
    }).filter((row) => row.productName && row.warehouse);

    if (!rows.length) return { error: '截图表格没有可渲染的数据行。' };

    const groups = [];
    for (const row of rows) {
      const key = row.productId || row.productName;
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.rows.push(row);
      } else {
        groups.push({ key, rows: [row] });
      }
    }

    const regionTitle = reportItem?.region || rows.find((row) => row.region)?.region || '';
    const title = ['商品销售汇总表', regionTitle, timestamp].filter(Boolean).join(' - ');
    const tbody = groups.map((group) => group.rows.map((row, index) => {
      const warn = row.shortage > 0;
      const product = index === 0 ? `
        <td class="product-cell" rowspan="${group.rows.length}">
          <div class="product">
            ${row.image ? `<img src="${escapeHtml(row.image)}" alt="">` : '<span class="image-placeholder"></span>'}
            <div>
              ${row.productId ? `<div class="product-id">ID:${escapeHtml(row.productId)}</div>` : ''}
              <div class="product-name">${escapeHtml(row.productName)}</div>
            </div>
          </div>
        </td>
      ` : '';
      return `
        <tr class="${warn ? 'warn' : ''}">
          ${product}
          <td class="warehouse">${escapeHtml(row.warehouse || '-')}</td>
          <td>${escapeHtml(row.spec || '-')}</td>
          <td>${formatQuantityText(row.sales)}</td>
          <td>${formatQuantityText(row.estimate)}</td>
          <td class="${warn ? 'shortage' : ''}">${formatQuantityText(row.shortage)}</td>
          <td>${formatQuantityText(row.stock)}</td>
          <td>${formatQuantityText(row.diff)}</td>
        </tr>
      `;
    }).join('')).join('');

    document.body.innerHTML = `
      <div id="pdd-compact-report">
        <h1>${escapeHtml(title)}</h1>
        <table>
          <colgroup>
            <col class="col-product">
            <col class="col-warehouse">
            <col class="col-spec">
            <col class="col-num">
            <col class="col-num">
            <col class="col-num">
            <col class="col-num">
            <col class="col-num">
          </colgroup>
          <thead>
            <tr>
              <th>商品信息</th>
              <th>所属仓库</th>
              <th>规格</th>
              <th>实时销量</th>
              <th>预计缺单销量</th>
              <th>预计缺货量</th>
              <th>实际入库量</th>
              <th>分拣差异量</th>
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
        color: #4b5563;
      }
      #pdd-compact-report { width: 900px; background: #fff; }
      h1 {
        margin: 0;
        padding: 16px 10px 14px;
        text-align: center;
        color: #2f2f2f;
        font-size: 28px;
        line-height: 1.15;
        font-weight: 700;
      }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .col-product { width: 330px; }
      .col-warehouse { width: 126px; }
      .col-spec { width: 86px; }
      .col-num { width: 71px; }
      th {
        height: 50px;
        padding: 6px 5px;
        background: #e5e5e5;
        border-bottom: 1px solid #d8d8d8;
        color: #555;
        font-size: 14px;
        line-height: 1.18;
        text-align: center;
        font-weight: 700;
      }
      td {
        min-height: 52px;
        padding: 8px 6px;
        border-bottom: 1px solid #e5e7eb;
        color: #4b5563;
        font-size: 14px;
        line-height: 1.25;
        text-align: center;
        vertical-align: middle;
        word-break: break-word;
      }
      tr.warn td:not(.product-cell) { background: #fff1c7; }
      .shortage { color: #ef4444; font-weight: 800; }
      .warehouse { color: #555; font-weight: 500; }
      .product-cell { background: #fff; text-align: left; }
      .product { display: flex; align-items: center; gap: 8px; min-height: 58px; }
      .product img, .image-placeholder {
        width: 52px;
        height: 52px;
        flex: 0 0 52px;
        object-fit: contain;
        background: #f8fafc;
      }
      .image-placeholder { display: inline-block; border: 1px solid #e5e7eb; }
      .product-id {
        margin-bottom: 2px;
        color: #6b7280;
        font-size: 13px;
        line-height: 1.12;
        font-weight: 700;
      }
      .product-name {
        color: #ef5b5b;
        font-size: 14px;
        line-height: 1.15;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);

    const report = document.querySelector('#pdd-compact-report');
    return {
      rowCount: rows.length,
      warningCount: rows.filter((row) => row.shortage > 0).length,
      width: Math.ceil(report.scrollWidth),
      height: Math.ceil(report.scrollHeight),
    };
  }, { reportItem, timestamp });

  if (result.error) throw new Error(result.error);
  await page.setViewportSize({
    width: Math.max(900, result.width),
    height: Math.min(Math.max(900, result.height), 12000),
  }).catch(() => {});
  await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), null, { timeout: 10000 }).catch(() => {});
  const clip = await page.evaluate(() => {
    const report = document.querySelector('#pdd-compact-report');
    const rect = report?.getBoundingClientRect();
    return rect ? {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.ceil(rect.width),
      height: Math.ceil(report.scrollHeight),
    } : null;
  });
  if (!clip || clip.width <= 0 || clip.height <= 0) {
    throw new Error('无法确定完整截图范围。');
  }
  return { ...result, clip };
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
    console.log(`仓库剩余量预警：${warnings.length} 项。`);
    const rendered = await renderCompactReport(page, {
      reportItem,
      timestamp: compactReportTimestamp(),
    });
    if (rendered.rowCount !== tableState.visibleRows) {
      throw new Error(`截图生成校验失败：页面抓取 ${tableState.visibleRows} 条，长图渲染 ${rendered.rowCount} 条。`);
    }
    console.log(`截图报表行数：${rendered.rowCount}/${tableState.visibleRows}。`);
    await closeBlockingModals(page);
    await savePddStorageState(reportContext, cfg.storageStatePath)
      .then((storagePath) => console.log(`Refreshed PDD storageState at ${storagePath}.`))
      .catch((error) => console.warn(`Could not refresh PDD storageState: ${error.message}`));
    await mkdir(cfg.outputDir, { recursive: true });
    const suffix = reportItem ? `-${reportItem.id}-${(reportItem.warehouse || reportItem.groupName || reportItem.chatName).replace(/[\\/:*?"<>|\s]+/g, '_')}` : '';
    const stamp = fileTimestamp();
    const output = path.join(cfg.outputDir, `pdd-order-report-${stamp}${suffix}.png`);
    await page.screenshot({ path: output, clip: rendered.clip, animations: 'disabled' });
    return { screenshots: [output], warnings, total: tableState.total };
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

function groupedWarningLines(warnings, reportItem = null) {
  const groups = [];
  const byProduct = new Map();
  for (const warning of warnings) {
    const productName = warning.productName || '未知商品';
    let group = byProduct.get(productName);
    if (!group) {
      group = { productName, rows: [] };
      groups.push(group);
      byProduct.set(productName, group);
    }
    group.rows.push(warning);
  }
  const lines = [];
  for (const group of groups) {
    lines.push(group.productName);
    for (const warning of group.rows) {
      const region = warning.region || reportItem?.region || '';
      const place = [region, warning.warehouse].filter(Boolean).join('  ');
      lines.push(`${place} 补货 ${formatQuantity(warning.replenishment)}份`);
    }
  }
  return lines;
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
      [{ tag: 'text', text: `仓库剩余量预警（${warnings.length} 项）：仓库总库存低于仓库预估总销售数` }],
      ...warnings.map((warning) => [{
        tag: 'text',
        text: `${warning.productName}｜${warning.region || reportItem?.region || ''} ${warning.warehouse}｜补货 ${formatQuantity(warning.replenishment)}份`,
      }]),
    ]
    : [[{ tag: 'text', text: '暂无仓库剩余量预警' }]];
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
  if (!warnings.length) return `暂无仓库剩余量预警\n${timestamp} 数据截图，共 ${imageCount} 张，总计 ${total} 条商品`;
  return groupedWarningLines(warnings, reportItem).join('\n');
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

function compactAlertText(value, maxLength = 1800) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...（已截断，完整内容见上报日志）`;
}

async function sendReportFailureAlert(cfg, token, notification, failure) {
  const adminGroup = notification?.adminGroup || DEFAULT_NOTIFICATION_CONFIG.adminGroup;
  if (!adminGroup) return;
  try {
    const alertToken = token || await tenantToken(cfg);
    const chat = await findChat(alertToken, cfg, adminGroup);
    const rows = [
      [{ tag: 'text', text: `${beijingTimestamp()} 定时上报失败` }],
      [{ tag: 'text', text: `原因：${failure.reason || '未知错误'}` }],
    ];
    const ruleInfo = [
      failure.ruleLabel ? `规则 ${failure.ruleLabel}` : '',
      failure.warehouse || failure.groupName || '',
    ].filter(Boolean).join(' ');
    if (ruleInfo) rows.push([{ tag: 'text', text: ruleInfo }]);
    if (failure.wechatRoomName) {
      rows.push([{ tag: 'text', text: `应该发送的微信群：${failure.wechatRoomName}` }]);
    }
    if (failure.mentionNames?.length) {
      rows.push([{ tag: 'text', text: `应 @ 成员：${failure.mentionNames.join(', ')}` }]);
    }
    if (failure.wechatText) {
      rows.push([{ tag: 'text', text: `应发文字：\n${compactAlertText(failure.wechatText)}` }]);
    }
    if (failure.imagePaths?.length) {
      rows.push([{ tag: 'text', text: `应发图片路径：\n${failure.imagePaths.join('\n')}` }]);
      for (const imagePath of failure.imagePaths) {
        try {
          const imageKey = await uploadImage(alertToken, imagePath);
          if (imageKey) rows.push([{ tag: 'img', image_key: imageKey }]);
        } catch (error) {
          rows.push([{ tag: 'text', text: `图片上传到飞书失败：${imagePath}（${error.message}）` }]);
        }
      }
    }
    const content = {
      zh_cn: {
        title: '多多数字管家上报失败',
        content: rows,
      },
    };
    await feishuJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alertToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: chat.chat_id, msg_type: 'post', content: JSON.stringify(content) }),
    });
    console.log(`上报失败告警已发送到管理通知群 ${chat.name}。`);
  } catch (error) {
    console.error(`上报失败告警发送失败：${error.message}`);
  }
}

async function runConfiguredReports(cfg, token, configs, {
  dryRun = false,
  all = false,
  ids = [],
  channel = 'both',
  notification = normalizeNotificationConfig(),
} = {}) {
  const maxAttempts = Math.max(1, positiveInteger(notification.maxRetries, DEFAULT_NOTIFICATION_CONFIG.maxRetries) + 1);
  const retryDelayMs = positiveInteger(notification.retryDelaySeconds, DEFAULT_NOTIFICATION_CONFIG.retryDelaySeconds) * 1000;
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
    let lastFailureContext = null;
    for (let attempt = 1; attempt <= maxAttempts && !completed; attempt += 1) {
      try {
        console.log(`开始上报规则 ${ruleLabel}（第 ${attempt}/${maxAttempts} 次）：@${item.mentionNames.join(', ')}.`);
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
        const wechatText = sendWechat
          ? formatWechatText(item, report.warnings, report.total, report.screenshots.length, beijingTimestamp())
          : '';
        lastFailureContext = {
          ruleLabel,
          warehouse: item.warehouse,
          groupName: item.groupName,
          wechatRoomName: sendWechat ? item.wechatRoomName : '',
          mentionNames: sendWechat ? (item.wechatMentionNames || []) : [],
          wechatText,
          imagePaths: sendWechat ? report.screenshots : [],
        };
        if (!dryRun && sendFeishu) {
          const imageKeys = [];
          for (const screenshot of report.screenshots) imageKeys.push(await uploadImage(token, screenshot));
          await sendReport(token, chat.chat_id, members, imageKeys, report.warnings, item);
          console.log(`规则 #${item.id} 已发送到飞书 ${chat.name}.`);
        }
        // WeChat send (if configured)
        if (!dryRun && sendWechat) {
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
        if (attempt < maxAttempts) {
          console.log(`${retryDelayMs / 1000} 秒后重试规则 ${ruleLabel}。`);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    if (!completed) {
      const reason = lastError?.message || '未知错误';
      failures.push(`${ruleLabel} ${item.warehouse || item.groupName}: ${reason}`);
      console.error(`规则 ${ruleLabel} 已达到最大重试次数，继续下一个仓库。`);
      if (!dryRun) {
        await sendReportFailureAlert(cfg, token, notification, {
          ruleLabel,
          warehouse: item.warehouse,
          groupName: item.groupName,
          reason,
          ...lastFailureContext,
        });
      }
    }
    if (queueIndex < due.length - 1 && !dryRun && channel !== 'feishu') {
      const delayMs = randomSendDelayMs(notification);
      if (delayMs > 0) {
        console.log(`等待 ${Math.round(delayMs / 1000)} 秒后继续下一个通知任务。`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
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
  const reportConfig = await loadReportConfig(cfg);
  const reportConfigs = reportConfig.items;
  if (reportConfigs.length) {
    await runConfiguredReports(cfg, token, reportConfigs, {
      dryRun,
      all,
      ids,
      channel,
      notification: reportConfig.notification,
    });
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
