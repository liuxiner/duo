import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pddStorageStatePath } from '../pdd-automation/clients/pdd-client.mjs';
import { loadPddStorageState, pddStorageStateHasUsableCookies } from '../pdd-automation/auth/session.mjs';
import { readJobLockStatus } from '../scripts/job-lock.mjs';
import { KANBAN_DEFAULTS, loadKanbanData } from './kanban-data.mjs';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(WEB_DIR, '..');
const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || APP_ROOT);
const NODE_ENTRY_ROOT = path.resolve(process.env.MAO_APP_ROOT || APP_ROOT);
const LOG_DIR = path.resolve(process.env.MAO_LOG_DIR || path.join(ROOT, 'logs'));
const PUBLIC_DIR = path.resolve(NODE_ENTRY_ROOT, 'dist', 'public');
const STATIC_MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

async function loadDotEnv(file = '.env', override = false) {
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
    if (override || !(key in process.env)) process.env[key] = value;
  }
}

await loadDotEnv();
process.env.PDD_CDP_URL ||= 'http://127.0.0.1:9222';

const PORT = Number(process.env.PORT || 4173);
const LOCAL_WECHAT_BRIDGE_URL = `http://127.0.0.1:${PORT}`;
const REPORT_CONFIG_PATH = path.resolve(ROOT, process.env.PDD_REPORT_CONFIG_PATH || 'data/report-config.json');
const DESKTOP_WECHAT_LOG_RE = /^wechat-desktop-automation-(\d{4}-\d{2}-\d{2})\.log$/;
const DESKTOP_WECHAT_LOCK_PATH = path.join(LOG_DIR, 'wechat-desktop-automation.lock');
const DESKTOP_WECHAT_LOCK_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const REPORT_TIMEOUT_MS = 30 * 60 * 1000;
const RESERVATION_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_KILL_GRACE_MS = 5 * 1000;
const FEISHU_REPORT_ENABLED = process.env.MAO_ENABLE_FEISHU_REPORT === 'true';
const WEB_WECHAT_ENABLED = process.platform === 'win32' || process.env.MAO_ENABLE_WEB_WECHAT === 'true';
const DESKTOP_WECHAT_ENABLED = process.platform === 'darwin';
const APP_ROUTE_PATHS = new Set(['/', '/sync', '/config', '/wechat', '/heartbeat', '/logs', '/desktop']);
let activeSync = null;
let activeReport = null;
let activeReservation = null;
let activeScheduler = null;
let schedulerTimer = null;
let schedulerLastMinuteKey = '';
let taskQueueRunning = false;
let taskSequence = 0;
let heartbeatTimer = null;
let heartbeatRunning = false;
const taskQueue = {
  status: 'idle',
  logs: [],
  pending: [],
  active: null,
  lastCompleted: null,
  startedAt: '',
  updatedAt: '',
};
const heartbeatMonitor = { status: 'idle', logs: [], previewLogs: [] };
const monitorNotificationQueue = { status: 'idle', logs: [], previewLogs: [] };
const desktopWechatSmokeState = {
  status: 'unknown',
  ok: null,
  disabled: true,
  reason: '等待微信上报自检',
  checkedAt: '',
  lastFailureSignature: '',
};
let desktopWechatSmokePromise = null;
const wechatSSEClients = new Set();

function disabledWechatStatus() {
  return {
    status: 'disabled',
    loggedInUser: '',
    qrAvailable: false,
    disabled: true,
    reason: 'Web 微信机器人已隐藏，当前默认使用桌面微信 App 发送。Windows 已恢复使用 Wechaty 通道。',
  };
}

async function createWechatyBot() {
  if (!WEB_WECHAT_ENABLED) {
    return {
      qrData: null,
      getStatus: disabledWechatStatus,
      onScan: () => {},
      onLogin: () => {},
      onLogout: () => {},
      start: async () => disabledWechatStatus(),
      stop: async () => disabledWechatStatus(),
      sendToRoom: async () => {
        throw new Error(disabledWechatStatus().reason);
      },
    };
  }
  const { WechatyBot } = await import('../scripts/wechaty-bot.mjs');
  return new WechatyBot({ name: 'pdd-wechaty-bot' });
}

const wechatyBot = await createWechatyBot();

const DEFAULT_REPORT_CONFIG = {
  schedulerEnabled: false,
  notification: {
    adminGroup: '杭州交仓',
    mentionNames: ['鑫'],
    senderStrategy: 'http_api',
    sendIntervalSeconds: { min: 2, max: 5 },
    maxRetries: 2,
    retryDelaySeconds: 10,
  },
  heartbeat: {
    enabled: true,
    intervalMinutes: 5,
    feishuChatName: '杭州交仓',
    mentionNames: ['鑫'],
  },
  reservation: {
    enabled: false,
    firstRunTimes: ['21:30', '22:05'],
    lastRunTimes: ['23:10'],
    createLastAppointmentEnabled: true,
    dryRun: true,
    notifyAdmin: true,
    items: [
      {
        id: '1',
        region: '浙江省',
        warehouseGroup: '杭州仓组',
        centerWarehouses: ['杭州中心1仓', '杭州中心2仓'],
        driverMobile: '15090976592',
        quantity: 100,
        preferredHour: '21:00',
        firstNotifyGroup: '杭州交仓',
        lastNotifyGroup: '杭州交仓',
        enabled: false,
      },
      {
        id: '2',
        region: '浙江省',
        warehouseGroup: '宁波仓组',
        centerWarehouses: ['宁波1仓'],
        driverMobile: '13486621270',
        quantity: 100,
        preferredHour: '21:00',
        firstNotifyGroup: '安如山~宁波中泓北港云仓',
        lastNotifyGroup: '安如山-杭州办公室',
        enabled: false,
      },
      {
        id: '3',
        region: '浙江省',
        warehouseGroup: '温州仓组',
        centerWarehouses: ['温州1仓'],
        driverMobile: '17767375369',
        quantity: 100,
        preferredHour: '21:00',
        firstNotifyGroup: '杭州安如山—温州诚达云仓',
        lastNotifyGroup: '安如山-杭州办公室',
        enabled: false,
      },
    ],
  },
  scheduleMonitor: {
    enabled: false,
    runTimes: ['22:45'],
    daysAhead: 1,
    notifyOnChangeOnly: false,
  },
  violationCheck: {
    enabled: false,
    runTimes: ['08:50', '14:50', '20:50'],
    onlyPendingAppeals: true,
    notifyWhenEmpty: false,
  },
  items: [
    { id: '1', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['06:00', '07:00', '08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '2', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['12:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
    { id: '3', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '4', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
    { id: '5', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '6', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
  ],
};

const APP_CONFIG_FIELDS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_REPORT_CHAT_NAME',
  'FEISHU_REPORT_CHAT_ID',
  'FEISHU_WIKI_URL',
  'FEISHU_WIKI_NODE_TOKEN',
  'FEISHU_SPREADSHEET_TOKEN',
  'FEISHU_SHEET_ID',
  'FEISHU_START_CELL',
  'FEISHU_DAILY_SHEET_NAME_FORMAT',
  'FEISHU_KANBAN_RAW_URL',
  'FEISHU_KANBAN_RULES_URL',
  'FEISHU_KANBAN_MANUAL_URL',
  'FEISHU_KANBAN_REVIEW_URL',
  'FEISHU_KANBAN_WRITEBACK',
  'PDD_CDP_URL',
  'WECHATY_CDP_URL',
];

const KANBAN_CONFIG_FIELDS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_KANBAN_RAW_URL',
  'FEISHU_KANBAN_RULES_URL',
  'FEISHU_KANBAN_MANUAL_URL',
  'FEISHU_KANBAN_REVIEW_URL',
  'FEISHU_KANBAN_WRITEBACK',
];

const WEB_WECHAT_CDP_SERVICE = { envKey: 'WECHATY_CDP_URL', title: '微信 Chrome 服务', defaultPort: 9333, candidatePorts: 12 };
const CDP_SERVICES = {
  pddChrome: { envKey: 'PDD_CDP_URL', title: 'PDD Chrome 服务', defaultPort: 9222, candidatePorts: 12 },
  ...(WEB_WECHAT_ENABLED ? { wechatChrome: WEB_WECHAT_CDP_SERVICE } : {}),
};

async function readEnvConfig(fields) {
  await loadDotEnv('.env', true);
  return Object.fromEntries(fields.map((key) => [key, process.env[key] || '']));
}

function envValue(value) {
  return JSON.stringify(String(value || ''));
}

async function saveEnvConfig(input, fields) {
  const envPath = path.resolve(ROOT, '.env');
  let text = '';
  try { text = await readFile(envPath, 'utf8'); } catch {}
  const current = await readEnvConfig(fields);
  const values = Object.fromEntries(fields.map((key) => {
    const nextValue = Object.prototype.hasOwnProperty.call(input || {}, key) ? input[key] : current[key];
    return [key, String(nextValue || '').trim()];
  }));
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !(match[1] in values)) return line;
    const key = match[1];
    seen.add(key);
    return `${key}=${envValue(values[key])}`;
  });
  for (const key of fields) {
    if (!seen.has(key)) lines.push(`${key}=${envValue(values[key])}`);
    process.env[key] = values[key];
  }
  await writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  return values;
}

function redactAppConfig(values) {
  return {
    ...values,
    FEISHU_APP_SECRET: '',
    HAS_FEISHU_APP_SECRET: Boolean(values.FEISHU_APP_SECRET),
  };
}

async function readAppConfig() {
  return redactAppConfig(await readEnvConfig(APP_CONFIG_FIELDS));
}

async function saveAppConfig(input) {
  const updates = { ...(input || {}) };
  if (typeof updates.FEISHU_APP_SECRET === 'string' && !updates.FEISHU_APP_SECRET.trim()) {
    delete updates.FEISHU_APP_SECRET;
  }
  return redactAppConfig(await saveEnvConfig(updates, APP_CONFIG_FIELDS));
}

function truthyConfig(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function kanbanConfigFromEnv(values) {
  return {
    appId: values.FEISHU_APP_ID || '',
    hasAppSecret: Boolean(values.FEISHU_APP_SECRET),
    authReady: Boolean(values.FEISHU_APP_ID && values.FEISHU_APP_SECRET),
    rawUrl: values.FEISHU_KANBAN_RAW_URL || KANBAN_DEFAULTS.rawSourceUrl,
    rulesUrl: values.FEISHU_KANBAN_RULES_URL || KANBAN_DEFAULTS.rulesSourceUrl,
    manualUrl: values.FEISHU_KANBAN_MANUAL_URL || KANBAN_DEFAULTS.manualInputUrl,
    reviewUrl: values.FEISHU_KANBAN_REVIEW_URL || KANBAN_DEFAULTS.reviewTargetUrl,
    writebackEnabled: truthyConfig(values.FEISHU_KANBAN_WRITEBACK, true),
  };
}

async function readKanbanConfig() {
  return kanbanConfigFromEnv(await readEnvConfig(KANBAN_CONFIG_FIELDS));
}

async function saveKanbanConfig(input) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(input || {}, 'appId')) {
    updates.FEISHU_APP_ID = input.appId;
  }
  if (typeof input?.appSecret === 'string' && input.appSecret.trim()) {
    updates.FEISHU_APP_SECRET = input.appSecret;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'rawUrl')) {
    updates.FEISHU_KANBAN_RAW_URL = input.rawUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'rulesUrl')) {
    updates.FEISHU_KANBAN_RULES_URL = input.rulesUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'manualUrl')) {
    updates.FEISHU_KANBAN_MANUAL_URL = input.manualUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'reviewUrl')) {
    updates.FEISHU_KANBAN_REVIEW_URL = input.reviewUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'writebackEnabled')) {
    updates.FEISHU_KANBAN_WRITEBACK = input.writebackEnabled ? 'true' : 'false';
  }
  return kanbanConfigFromEnv(await saveEnvConfig(updates, KANBAN_CONFIG_FIELDS));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function publicFilePath(requestPathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  return filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) ? filePath : null;
}

async function sendFile(response, filePath, { cacheControl = 'no-store' } = {}) {
  const body = await readFile(filePath);
  const contentType = STATIC_MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  response.end(body);
}

async function servePublicAsset(requestPathname, response) {
  if (!requestPathname.startsWith('/assets/')) return false;
  const filePath = publicFilePath(requestPathname);
  if (!filePath) {
    sendJson(response, 400, { error: 'Invalid asset path' });
    return true;
  }
  if (!existsSync(filePath)) {
    sendJson(response, 404, { error: 'Asset not found' });
    return true;
  }
  await sendFile(response, filePath, { cacheControl: 'public, max-age=31536000, immutable' });
  return true;
}

async function serveKanbanHtml(response) {
  const builtHtml = path.join(PUBLIC_DIR, 'kanban.html');
  const filePath = existsSync(builtHtml) ? builtHtml : path.join(WEB_DIR, 'kanban.html');
  await sendFile(response, filePath, { cacheControl: 'no-store' });
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function localCandidateUrls(service, configuredUrl) {
  const candidates = new Set();
  try {
    const parsed = configuredUrl ? new URL(configuredUrl) : null;
    if (parsed && isLoopbackHost(parsed.hostname)) candidates.add(parsed.port ? Number(parsed.port) : service.defaultPort);
  } catch {}
  for (let offset = 0; offset < service.candidatePorts; offset += 1) {
    candidates.add(service.defaultPort + offset);
  }
  return [...candidates]
    .filter((port) => Number.isInteger(port) && port > 0)
    .map((port) => `http://127.0.0.1:${port}`);
}

async function probeChromeEndpoint(url) {
  try {
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { ok: true, browser: body.Browser || 'Chrome' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function resolveCdpService(id, configuredUrl) {
  const service = CDP_SERVICES[id];
  if (!service) throw new Error(`Unknown CDP service: ${id}`);
  const currentUrl = String(configuredUrl || '').trim() || `http://127.0.0.1:${service.defaultPort}`;
  const directProbe = await probeChromeEndpoint(currentUrl);
  if (directProbe.ok) {
    return { ok: true, id, title: service.title, detail: `${directProbe.browser} · ${currentUrl}`, url: currentUrl, changed: false };
  }

  try {
    const parsed = new URL(currentUrl);
    if (!isLoopbackHost(parsed.hostname)) {
      return { ok: false, id, title: service.title, detail: `无法连接 ${currentUrl}：${directProbe.error}`, url: currentUrl, changed: false };
    }
  } catch {
    return { ok: false, id, title: service.title, detail: `地址格式无效：${currentUrl}`, url: currentUrl, changed: false };
  }

  for (const candidateUrl of localCandidateUrls(service, currentUrl)) {
    if (candidateUrl === currentUrl) continue;
    const probe = await probeChromeEndpoint(candidateUrl);
    if (!probe.ok) continue;
    await saveAppConfig({ [service.envKey]: candidateUrl });
    return {
      ok: true,
      id,
      title: service.title,
      detail: `${probe.browser} · 已自动切换到 ${candidateUrl}`,
      url: candidateUrl,
      changed: true,
    };
  }

  return {
    ok: false,
    id,
    title: service.title,
    detail: `无法连接 ${currentUrl}，也未发现可用的本地调试端口。`,
    url: currentUrl,
    changed: false,
  };
}

async function checkCdpService(id, title, configuredUrl, expectedPort) {
  const resolved = await resolveCdpService(id, configuredUrl);
  if (resolved.ok) {
    return { id, ok: true, title, detail: resolved.detail, port: new URL(resolved.url).port || expectedPort, changed: resolved.changed, url: resolved.url };
  }
  const url = String(configuredUrl || '').trim();
  return { id, ok: false, title, detail: resolved.detail || `无法连接 ${url}`, port: expectedPort, changed: false, url };
}

async function checkFeishuCredentials() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return { id: 'feishuCredentials', ok: false, title: '飞书应用凭证', detail: '尚未完成飞书 App ID 和 App Secret 配置' };
  }
  try {
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw new Error(body.msg || `HTTP ${response.status}`);
    return { id: 'feishuCredentials', ok: true, title: '飞书应用凭证', detail: '飞书鉴权成功' };
  } catch (error) {
    return { id: 'feishuCredentials', ok: false, title: '飞书应用凭证', detail: `飞书鉴权失败：${error.message}` };
  }
}

async function preflightChecks() {
  await loadDotEnv('.env', true);
  process.env.PDD_CDP_URL ||= 'http://127.0.0.1:9222';
  process.env.WECHATY_CDP_URL ||= 'http://127.0.0.1:9333';
  const checks = await Promise.all([
    checkCdpService('pddChrome', 'PDD Chrome 服务', process.env.PDD_CDP_URL, 9222),
    ...(WEB_WECHAT_ENABLED
      ? [checkCdpService('wechatChrome', '微信 Chrome 服务', process.env.WECHATY_CDP_URL, 9333)]
      : []),
    checkFeishuCredentials(),
  ]);
  const feishuTarget = Boolean(process.env.FEISHU_WIKI_URL?.trim() || process.env.FEISHU_WIKI_NODE_TOKEN?.trim() || process.env.FEISHU_SPREADSHEET_TOKEN?.trim());
  checks.push(
    { id: 'feishuTarget', ok: feishuTarget, title: '飞书表格目标', detail: feishuTarget ? 'Wiki 或 Spreadsheet 目标已配置' : '尚未配置飞书 Wiki 或 Spreadsheet 目标' },
  );
  return { ok: checks.every((item) => item.ok), checks };
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 256_000) throw new Error('Request body is too large.');
  }
  return JSON.parse(body || '{}');
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function compactLogs(logs = []) {
  return logs.slice(-8);
}

function appendLogs(target, chunk) {
  const lines = String(chunk)
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .filter(Boolean);
  target.logs.push(...lines);
  if (target.logs.length > 500) target.logs.splice(0, target.logs.length - 500);
}

function appendTaskQueueLog(message) {
  appendLogs(taskQueue, `[任务队列] ${beijingTimestamp()} ${message}`);
  taskQueue.updatedAt = nowIso();
}

function beijingDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function listDesktopWechatLogs() {
  await mkdir(LOG_DIR, { recursive: true });
  const names = await readdir(LOG_DIR).catch(() => []);
  const logs = await Promise.all(names
    .map((name) => {
      const match = name.match(DESKTOP_WECHAT_LOG_RE);
      return match ? { name, date: match[1] } : null;
    })
    .filter(Boolean)
    .map(async (item) => {
      const info = await stat(path.join(LOG_DIR, item.name)).catch(() => null);
      return { ...item, size: info?.size || 0, updatedAt: info?.mtime?.toISOString?.() || '' };
    }));
  return logs.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
}

async function readDesktopWechatLogLines(name, maxLines = 600) {
  if (!DESKTOP_WECHAT_LOG_RE.test(name)) return [];
  const logPath = path.join(LOG_DIR, name);
  let handle;
  try {
    const info = await stat(logPath);
    const maxBytes = 512 * 1024;
    const start = Math.max(0, info.size - maxBytes);
    const length = info.size - start;
    handle = await open(logPath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.replace(/^[^\n]*(?:\n|$)/, '');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

function desktopWechatHelperPath() {
  const executable = process.platform === 'win32' ? 'mao-wechat-automation.ps1' : 'mao-wechat-automation';
  const candidates = [
    path.join(NODE_ENTRY_ROOT, 'bin', executable),
    path.join(APP_ROOT, 'bin', executable),
    path.join(APP_ROOT, 'dist', 'runtime', 'bin', executable),
    path.join(APP_ROOT, 'desktop', 'resources', 'runtime', 'bin', executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function assertDesktopWechatAvailable() {
  if (!DESKTOP_WECHAT_ENABLED) {
    throw new Error('Windows 已恢复使用 Wechaty 通道，禁止操作桌面微信 App。');
  }
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDesktopWechatAutomationLock() {
  let lock = null;
  try {
    lock = JSON.parse(await readFile(DESKTOP_WECHAT_LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
  const startedAtMs = Date.parse(lock.startedAt || '');
  const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : DESKTOP_WECHAT_LOCK_TTL_MS + 1;
  if (ageMs > DESKTOP_WECHAT_LOCK_TTL_MS || !isPidAlive(lock.pid)) {
    await unlink(DESKTOP_WECHAT_LOCK_PATH).catch(() => {});
    return null;
  }
  return lock;
}

async function acquireDesktopWechatAutomationLock(owner, args = []) {
  const existing = await readDesktopWechatAutomationLock();
  if (existing) {
    throw new Error(`桌面微信自动化正在运行：${existing.owner || 'unknown'}，请稍后再试。`);
  }
  await mkdir(LOG_DIR, { recursive: true });
  const lock = {
    pid: process.pid,
    owner,
    args: args.map((arg) => String(arg || '').slice(0, 80)),
    startedAt: new Date().toISOString(),
  };
  try {
    await writeFile(DESKTOP_WECHAT_LOCK_PATH, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const racedLock = await readDesktopWechatAutomationLock();
      throw new Error(`桌面微信自动化正在运行：${racedLock?.owner || 'unknown'}，请稍后再试。`);
    }
    throw error;
  }
  return async () => {
    let current = null;
    try {
      current = JSON.parse(await readFile(DESKTOP_WECHAT_LOCK_PATH, 'utf8'));
    } catch {}
    if (current?.pid === lock.pid && current?.startedAt === lock.startedAt) {
      await unlink(DESKTOP_WECHAT_LOCK_PATH).catch(() => {});
    }
  };
}

async function runDesktopWechatHelper(args, timeoutMs = 120_000, owner = 'web-server') {
  assertDesktopWechatAvailable();
  const releaseLock = await acquireDesktopWechatAutomationLock(owner, args);
  try {
    return await new Promise((resolve, reject) => {
      if (process.platform !== 'darwin' && process.platform !== 'win32') {
        reject(new Error(`当前系统暂不支持桌面微信发送：${process.platform}`));
        return;
      }
      const helperPath = desktopWechatHelperPath();
      const command = process.platform === 'win32' ? 'powershell.exe' : helperPath;
      const helperArgs = process.platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, ...args]
        : args;
      const child = spawn(command, helperArgs, {
        cwd: ROOT,
        env: {
          ...process.env,
          MAO_APP_ROOT: NODE_ENTRY_ROOT,
          MAO_WORKSPACE_PATH: ROOT,
          MAO_LOG_DIR: LOG_DIR,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`桌面微信 helper 超时（${Math.round(timeoutMs / 1000)} 秒）。`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error((stderr || stdout || `helper 退出 code=${code} signal=${signal}`).trim()));
      });
    });
  } finally {
    await releaseLock();
  }
}

async function sendToDesktopWechat({ roomName, text = '', imagePaths = [], mentionNames = [] }) {
  const helperPath = desktopWechatHelperPath();
  await stat(helperPath).catch(() => {
    throw new Error(`桌面微信 helper 不存在：${helperPath}`);
  });
  const normalizedMentions = Array.isArray(mentionNames)
    ? mentionNames.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const normalizedImages = Array.isArray(imagePaths)
    ? imagePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const args = [
    `--room=${String(roomName || '').trim()}`,
    `--mentions=${normalizedMentions.join(',')}`,
    `--text=${String(text || '')}`,
    '--send',
    '--select-method=click-first',
  ];
  for (const imagePath of normalizedImages) args.push(`--image=${imagePath}`);
  let result;
  try {
    result = await runDesktopWechatHelper(args, 120_000, 'web-send');
  } catch (error) {
    markDesktopWechatSmokeFailure(`微信 App 上报发送失败：${error.message}`, 'send');
    throw error;
  }
  let payload = null;
  try {
    payload = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
  } catch {}
  return {
    channel: 'desktop_wechat',
    roomName,
    mentionNames: normalizedMentions,
    imageCount: normalizedImages.length,
    helper: payload,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function appendMonitorNotificationLog(message) {
  appendLogs(monitorNotificationQueue, `[监控通知] ${beijingTimestamp()} ${message}`);
}

async function sendMonitorErrorNotification(failure) {
  monitorNotificationQueue.status = 'running';
  monitorNotificationQueue.startedAt = nowIso();
  monitorNotificationQueue.error = null;
  try {
    const config = await readReportConfig();
    const notification = config.notification || defaultNotificationConfig();
    const adminGroup = notification.adminGroup || DEFAULT_REPORT_CONFIG.notification.adminGroup;
    appendMonitorNotificationLog(`队列 1/1：管理通知群 ${adminGroup} -> 发送监控错误的上报。`);
    const token = await feishuTenantToken();
    const chat = await findFeishuChatWithFallback(token, adminGroup, '管理通知群');
    if (chat.fallbackReason) appendMonitorNotificationLog(chat.fallbackReason);
    const mentionNodes = [];
    for (const name of notification.mentionNames || []) {
      const member = await findFeishuMember(token, chat.chat_id, name);
      mentionNodes.push(
        { tag: 'at', user_id: member.member_id, user_name: member.name },
        { tag: 'text', text: ' ' },
      );
    }
    const content = {
      zh_cn: {
        title: '多多数字管家监控错误',
        content: [
          [...mentionNodes, { tag: 'text', text: `${beijingTimestamp()} 微信上报通道自检未通过` }],
          [{ tag: 'text', text: `错误：${failure.reason}` }],
          [{ tag: 'text', text: '已禁用微信上报按钮和自动上报入口，请修复微信登录/权限/安装后重新检测。' }],
        ],
      },
    };
    await feishuJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: chat.chat_id, msg_type: 'post', content: JSON.stringify(content) }),
      signal: AbortSignal.timeout(10_000),
    });
    appendMonitorNotificationLog(`监控错误已发送到管理通知群 ${chat.name}。`);
    monitorNotificationQueue.status = 'completed';
    monitorNotificationQueue.finishedAt = nowIso();
  } catch (error) {
    appendMonitorNotificationLog(`监控错误发送失败：${error.message}`);
    monitorNotificationQueue.status = 'failed';
    monitorNotificationQueue.error = error.message;
    monitorNotificationQueue.finishedAt = nowIso();
  }
}

function queueMonitorErrorNotificationOnce(failure) {
  const signature = `${failure.phase}:${failure.reason}`;
  if (desktopWechatSmokeState.lastFailureSignature === signature) return;
  desktopWechatSmokeState.lastFailureSignature = signature;
  sendMonitorErrorNotification(failure).catch((error) => {
    appendMonitorNotificationLog(`监控错误发送异常：${error.message}`);
  });
}

async function disableSchedulerConfigForWechatFailure() {
  try {
    const config = await readReportConfig();
    if (!config.schedulerEnabled) return;
    config.schedulerEnabled = false;
    await saveReportConfig(config);
    appendMonitorNotificationLog('已关闭定时上报配置。');
  } catch (error) {
    appendMonitorNotificationLog(`关闭定时上报配置失败：${error.message}`);
  }
}

function markDesktopWechatSmokeFailure(reason, phase = 'smoke') {
  const failure = {
    phase,
    reason: String(reason || '微信 App 上报 smoke test 未通过'),
    checkedAt: nowIso(),
  };
  desktopWechatSmokeState.status = 'failed';
  desktopWechatSmokeState.ok = false;
  desktopWechatSmokeState.disabled = true;
  desktopWechatSmokeState.reason = failure.reason;
  desktopWechatSmokeState.checkedAt = failure.checkedAt;
  disableSchedulerConfigForWechatFailure().catch((error) => {
    appendMonitorNotificationLog(`关闭定时上报配置异常：${error.message}`);
  });
  queueMonitorErrorNotificationOnce(failure);
  return desktopWechatSmokeState;
}

function describeWechatyLoginStatus(status) {
  const currentStatus = status?.status || '未知';
  if (currentStatus === 'logged-in') return `微信机器人已登录：${status.loggedInUser || '-'}`;
  if (currentStatus === 'scanning') return '微信机器人等待扫码登录。';
  if (currentStatus === 'starting') return '微信机器人正在启动。';
  if (currentStatus === 'error') return `微信机器人启动失败：${status.error || '未知错误'}`;
  if (currentStatus === 'disabled') return status.reason || '微信机器人已禁用。';
  return `微信机器人未登录（当前状态：${currentStatus}）。请先启动机器人并扫码登录。`;
}

function updateWechatyLoginSmokeState() {
  const status = wechatyBot.getStatus();
  const loggedIn = status.status === 'logged-in';
  Object.assign(desktopWechatSmokeState, {
    status: loggedIn ? 'completed' : 'failed',
    ok: loggedIn,
    disabled: !loggedIn,
    reason: describeWechatyLoginStatus(status),
    checkedAt: nowIso(),
    channel: 'wechaty',
    lastFailureSignature: loggedIn ? '' : desktopWechatSmokeState.lastFailureSignature,
  });
  return desktopWechatSmokeState;
}

async function ensureWechatyLoginStarted() {
  const current = wechatyBot.getStatus();
  if (['logged-in', 'scanning', 'starting'].includes(current.status)) return current;
  if (current.status === 'error') await wechatyBot.stop().catch(() => {});
  await wechatyBot.start();
  return wechatyBot.getStatus();
}

async function runDesktopWechatSmokeTest({ force = false } = {}) {
  if (WEB_WECHAT_ENABLED) {
    try {
      await ensureWechatyLoginStarted();
    } catch (error) {
      Object.assign(desktopWechatSmokeState, {
        status: 'failed',
        ok: false,
        disabled: true,
        reason: `微信机器人启动失败：${error.message}`,
        checkedAt: nowIso(),
        channel: 'wechaty',
      });
      return desktopWechatSmokeState;
    }
    return updateWechatyLoginSmokeState();
  }
  if (!force && desktopWechatSmokeState.ok === true) return desktopWechatSmokeState;
  if (desktopWechatSmokePromise) return desktopWechatSmokePromise;

  const runningLock = await readDesktopWechatAutomationLock();
  if (runningLock) {
    Object.assign(desktopWechatSmokeState, {
      status: desktopWechatSmokeState.ok === true ? 'completed' : 'unknown',
      ok: desktopWechatSmokeState.ok,
      disabled: desktopWechatSmokeState.ok !== true,
      reason: `微信 App 正在执行自动化任务，跳过本轮 smoke test：${runningLock.owner || 'unknown'}`,
      checkedAt: nowIso(),
    });
    appendMonitorNotificationLog(desktopWechatSmokeState.reason);
    return desktopWechatSmokeState;
  }

  desktopWechatSmokeState.status = 'running';
  desktopWechatSmokeState.ok = null;
  desktopWechatSmokeState.disabled = true;
  desktopWechatSmokeState.reason = '正在检测微信 App 上报通道';
  desktopWechatSmokeState.checkedAt = nowIso();
  desktopWechatSmokePromise = (async () => {
    try {
      const helperPath = desktopWechatHelperPath();
      await stat(helperPath);
      const result = await runDesktopWechatHelper(['--check-permission'], 15_000, 'smoke');
      let payload = {};
      try {
        payload = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
      } catch {}
      if (payload.trusted === false) {
        throw new Error('桌面应用尚未获得微信桌面自动化权限。');
      }
      Object.assign(desktopWechatSmokeState, {
        status: 'completed',
        ok: true,
        disabled: false,
        reason: '微信 App 上报 smoke test 通过',
        checkedAt: nowIso(),
        lastFailureSignature: '',
      });
      appendMonitorNotificationLog('微信 App 上报 smoke test 通过。');
      return desktopWechatSmokeState;
    } catch (error) {
      return markDesktopWechatSmokeFailure(error.message, 'smoke');
    } finally {
      desktopWechatSmokePromise = null;
    }
  })();
  return desktopWechatSmokePromise;
}

function scheduleDesktopWechatSmokeTest() {
  if (desktopWechatSmokeState.status !== 'unknown' || desktopWechatSmokePromise) return;
  runDesktopWechatSmokeTest().catch((error) => {
    markDesktopWechatSmokeFailure(error.message, 'smoke');
  });
}

async function ensureDesktopWechatSmokeReady() {
  const state = WEB_WECHAT_ENABLED
    ? await runDesktopWechatSmokeTest()
    : desktopWechatSmokeState.ok === true
    ? desktopWechatSmokeState
    : await runDesktopWechatSmokeTest();
  if (state.ok !== true) {
    const label = WEB_WECHAT_ENABLED ? '微信机器人登录检测' : '微信 App 上报 smoke test';
    throw new Error(`${label}未通过：${state.reason}`);
  }
  return state;
}

function summarizeTask(task) {
  if (!task) return { status: 'idle', logs: [], previewLogs: [] };
  const previewLogs = compactLogs(task.logs);
  const lastDate = [...task.logs].reverse().find((line) => /\d{4}-\d{2}-\d{2}/.test(line))?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const { child, ...safeTask } = task;
  return { ...safeTask, previewLogs, lastDate };
}

function nowIso() {
  return new Date().toISOString();
}

function beijingTimestamp(date = new Date()) {
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
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function normalizeNameList(value) {
  if (Array.isArray(value)) return value.map((name) => String(name).trim()).filter(Boolean);
  return String(value || '').split(/[,，]/).map((name) => name.trim()).filter(Boolean);
}

function enabledFromValue(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on', '启', '启动', '启用', 'enable', 'enabled'].includes(text);
}

function normalizeConfigTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeConfigTimeList(value, fallback = []) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(/[,\s，、-]+/));
  const normalized = [...new Set(values.map(normalizeConfigTime).filter(Boolean))];
  return normalized.length ? normalized : [...fallback];
}

function normalizeStringList(value) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(/[,\s，、]+/));
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^浙江仓组\d+-/, '');
}

function normalizePositiveInteger(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.round(next) : fallback;
}

function defaultHeartbeatConfig() {
  return { ...DEFAULT_REPORT_CONFIG.heartbeat, mentionNames: [...DEFAULT_REPORT_CONFIG.heartbeat.mentionNames] };
}

function defaultNotificationConfig() {
  const defaults = DEFAULT_REPORT_CONFIG.notification;
  return {
    ...defaults,
    mentionNames: [...defaults.mentionNames],
    sendIntervalSeconds: { ...defaults.sendIntervalSeconds },
  };
}

function normalizeNotificationConfig(input = {}) {
  const defaults = defaultNotificationConfig();
  const min = normalizePositiveInteger(input.sendIntervalSeconds?.min ?? input.sendIntervalMin, defaults.sendIntervalSeconds.min);
  const max = normalizePositiveInteger(input.sendIntervalSeconds?.max ?? input.sendIntervalMax, defaults.sendIntervalSeconds.max);
  return {
    adminGroup: String(input.adminGroup || defaults.adminGroup).trim(),
    mentionNames: normalizeNameList(input.mentionNames?.length ? input.mentionNames : defaults.mentionNames),
    senderStrategy: ['wechaty', 'desktop_wechat', 'http_api', 'weixin_v4'].includes(input.senderStrategy)
      ? input.senderStrategy
      : defaults.senderStrategy,
    sendIntervalSeconds: {
      min: Math.min(min, max),
      max: Math.max(min, max),
    },
    maxRetries: normalizePositiveInteger(input.maxRetries, defaults.maxRetries),
    retryDelaySeconds: normalizePositiveInteger(input.retryDelaySeconds, defaults.retryDelaySeconds),
  };
}

function defaultReservationConfig() {
  const defaults = DEFAULT_REPORT_CONFIG.reservation;
  return {
    ...defaults,
    firstRunTimes: [...defaults.firstRunTimes],
    lastRunTimes: [...defaults.lastRunTimes],
    items: defaults.items.map((item) => ({ ...item, centerWarehouses: [...item.centerWarehouses] })),
  };
}

function defaultReservationItemFor(item = {}, index = 0) {
  const id = String(item.id || item.index || item['序号'] || index + 1);
  const group = normalizeText(item.warehouseGroup || item.warehouse || item['仓组'] || item['仓库'] || '');
  return DEFAULT_REPORT_CONFIG.reservation.items.find((candidate) => String(candidate.id) === id)
    || DEFAULT_REPORT_CONFIG.reservation.items.find((candidate) => group && normalizeText(candidate.warehouseGroup) === group)
    || DEFAULT_REPORT_CONFIG.reservation.items[index]
    || {};
}

function normalizeReservationItem(item = {}, index = 0) {
  const defaults = defaultReservationItemFor(item, index);
  const centerWarehouses = normalizeStringList(item.centerWarehouses || item.centerWarehouse || item['中心仓']);
  const quantity = normalizePositiveInteger(item.quantity ?? item['预约数量'], defaults.quantity || 100);
  return {
    id: String(item.id || item.index || item['序号'] || defaults.id || index + 1),
    region: String(item.region || item['销售区域'] || item['区域'] || defaults.region || '').trim(),
    warehouseGroup: String(item.warehouseGroup || item.warehouse || item['仓组'] || item['仓库'] || defaults.warehouseGroup || '').trim(),
    centerWarehouses: centerWarehouses.length ? centerWarehouses : [...(defaults.centerWarehouses || [])],
    driverMobile: String(item.driverMobile || item['司机号码'] || defaults.driverMobile || '').trim(),
    quantity,
    preferredHour: normalizeConfigTime(item.preferredHour || item['预约时间'] || item['送货时间'] || defaults.preferredHour) || '21:00',
    firstNotifyGroup: String(item.firstNotifyGroup || item['首约通知群'] || defaults.firstNotifyGroup || '').trim(),
    lastNotifyGroup: String(item.lastNotifyGroup || item['尾约通知群'] || defaults.lastNotifyGroup || '').trim(),
    enabled: enabledFromValue(item.enabled ?? item['状态'] ?? item['状态(启/停)'], defaults.enabled ?? false),
  };
}

function normalizeReservationConfig(input = {}) {
  const defaults = defaultReservationConfig();
  const rawItems = Array.isArray(input.items) ? input.items : defaults.items;
  return {
    enabled: enabledFromValue(input.enabled, defaults.enabled),
    firstRunTimes: normalizeConfigTimeList(input.firstRunTimes, defaults.firstRunTimes),
    lastRunTimes: normalizeConfigTimeList(input.lastRunTimes, defaults.lastRunTimes),
    createLastAppointmentEnabled: typeof input.createLastAppointmentEnabled === 'boolean'
      ? input.createLastAppointmentEnabled
      : defaults.createLastAppointmentEnabled,
    dryRun: typeof input.dryRun === 'boolean' ? input.dryRun : defaults.dryRun,
    notifyAdmin: typeof input.notifyAdmin === 'boolean' ? input.notifyAdmin : defaults.notifyAdmin,
    items: rawItems.map(normalizeReservationItem),
  };
}

function normalizeScheduleMonitorConfig(input = {}) {
  const defaults = DEFAULT_REPORT_CONFIG.scheduleMonitor;
  return {
    enabled: enabledFromValue(input.enabled, defaults.enabled),
    runTimes: normalizeConfigTimeList(input.runTimes, defaults.runTimes),
    daysAhead: normalizePositiveInteger(input.daysAhead, defaults.daysAhead),
    notifyOnChangeOnly: typeof input.notifyOnChangeOnly === 'boolean' ? input.notifyOnChangeOnly : defaults.notifyOnChangeOnly,
  };
}

function normalizeViolationCheckConfig(input = {}) {
  const defaults = DEFAULT_REPORT_CONFIG.violationCheck;
  return {
    enabled: enabledFromValue(input.enabled, defaults.enabled),
    runTimes: normalizeConfigTimeList(input.runTimes, defaults.runTimes),
    onlyPendingAppeals: typeof input.onlyPendingAppeals === 'boolean' ? input.onlyPendingAppeals : defaults.onlyPendingAppeals,
    notifyWhenEmpty: typeof input.notifyWhenEmpty === 'boolean' ? input.notifyWhenEmpty : defaults.notifyWhenEmpty,
  };
}

const SYNC_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function kanbanRawSyncTarget() {
  const explicitRawUrl = process.env.FEISHU_KANBAN_RAW_URL || '';
  if (explicitRawUrl) {
    return {
      label: explicitRawUrl,
      env: {
        FEISHU_WIKI_URL: explicitRawUrl,
        FEISHU_SPREADSHEET_TOKEN: '',
        FEISHU_SHEET_ID: '',
      },
    };
  }
  return {
    label: process.env.FEISHU_WIKI_URL || process.env.FEISHU_SPREADSHEET_TOKEN || '',
    env: {},
  };
}

function describeKanbanWriteback(writeback) {
  if (!writeback) return '无写回结果';
  if (writeback.error) return `写回失败：${writeback.error}`;
  if (writeback.skipped) return `跳过写回：${writeback.reason || 'skipped'}`;
  return `写回 ${writeback.writtenCount || 0} 个日期`;
}

async function refreshKanbanReviewAfterSync(task, append) {
  task.phase = 'kanban-review';
  task.progressText = 'Order Management 已刷新，正在刷新 Kanban Review';
  append('[server] Order Management 飞书表已完成刷新，开始强制刷新 Kanban Review。');

  const payload = await loadKanbanData({ forceRefresh: true, forceWriteback: true });
  const writeback = payload.writeback || null;
  const summary = describeKanbanWriteback(writeback);

  task.kanbanReview = {
    refreshedAt: payload.refreshedAt,
    dates: payload.dates || [],
    writeback,
  };
  append(`[server] Kanban Review 刷新完成：${summary}。`);
  if (payload.warnings?.length) {
    payload.warnings.forEach((warning) => append(`[server] Kanban warning: ${warning}`));
  }
  if (writeback?.error) throw new Error(`Kanban Review ${writeback.error}`);
  return payload;
}

function isQueueTaskActive(task) {
  return ['queued', 'running', 'resetting'].includes(task?.status);
}

function scheduleConfigEnabled(config = {}) {
  return Boolean(
    config.schedulerEnabled
    || config.reservation?.enabled
    || config.scheduleMonitor?.enabled
    || config.violationCheck?.enabled
  );
}

function timeListIncludes(times = [], time = '') {
  return (Array.isArray(times) ? times : []).includes(time);
}

function summarizeQueueTask(task) {
  if (!task) return null;
  const { child, onSuccess, env, ...safeTask } = task;
  return safeTask;
}

function summarizeTaskQueue() {
  return {
    status: taskQueue.status,
    logs: taskQueue.logs,
    previewLogs: compactLogs(taskQueue.logs),
    pending: taskQueue.pending.map(summarizeQueueTask),
    active: summarizeQueueTask(taskQueue.active),
    lastCompleted: summarizeQueueTask(taskQueue.lastCompleted),
    updatedAt: taskQueue.updatedAt,
  };
}

function queuedTaskWithKey(key) {
  return taskQueue.active?.key === key || taskQueue.pending.some((task) => task.key === key);
}

function safeKill(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode != null) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function enqueueChildTask(task) {
  if (queuedTaskWithKey(task.key)) {
    throw new Error(`任务已在中心队列中：${task.label}`);
  }
  const queuedTask = {
    ...task,
    id: `task-${Date.now()}-${++taskSequence}`,
    status: 'queued',
    queuedAt: nowIso(),
    logs: task.logs || [],
  };
  queuedTask.taskRef.status = 'queued';
  queuedTask.taskRef.queueId = queuedTask.id;
  queuedTask.taskRef.queuedAt = queuedTask.queuedAt;
  appendLogs(queuedTask.taskRef, `[queue] 已加入中心任务队列：${queuedTask.label}`);
  taskQueue.pending.push(queuedTask);
  taskQueue.status = taskQueue.active ? 'running' : 'queued';
  appendTaskQueueLog(`入队：${queuedTask.label}；等待 ${taskQueue.pending.length} 个任务。`);
  setTimeout(processTaskQueue, 0).unref?.();
  return queuedTask;
}

async function finishQueuedTask(task, { code = 0, signal = '', error = null } = {}) {
  if (task.finishedAt) return;
  delete task.taskRef.child;
  task.finishedAt = nowIso();
  task.exitCode = code;
  task.signal = signal;
  taskQueue.active = null;

  if (error || task.timedOut || code !== 0) {
    const reason = error?.message || (task.timedOut ? '任务执行超时，已自动重置' : `子进程退出 code=${code} signal=${signal || '-'}`);
    task.status = 'failed';
    task.error = reason;
    task.taskRef.status = 'failed';
    task.taskRef.error = reason;
    task.taskRef.exitCode = code;
    task.taskRef.signal = signal;
    task.taskRef.finishedAt = task.finishedAt;
    appendLogs(task.taskRef, `[queue] 任务失败：${reason}`);
    appendTaskQueueLog(`失败：${task.label}；${reason}`);
  } else {
    try {
      if (task.onSuccess) await task.onSuccess(task.taskRef);
      task.status = 'completed';
      task.taskRef.status = task.successStatus || 'completed';
      task.taskRef.finishedAt = task.finishedAt;
      task.taskRef.exitCode = code;
      appendLogs(task.taskRef, `[queue] 任务完成：${task.label}`);
      appendTaskQueueLog(`完成：${task.label}`);
    } catch (successError) {
      task.status = 'failed';
      task.error = successError.message;
      task.taskRef.status = 'failed';
      task.taskRef.error = successError.message;
      task.taskRef.finishedAt = nowIso();
      appendLogs(task.taskRef, `[queue] 收尾失败：${successError.message}`);
      appendTaskQueueLog(`收尾失败：${task.label}；${successError.message}`);
    }
  }

  taskQueue.lastCompleted = task;
  taskQueue.status = taskQueue.pending.length ? 'queued' : 'idle';
  taskQueueRunning = false;
  setTimeout(processTaskQueue, 0).unref?.();
}

function processTaskQueue() {
  if (taskQueueRunning || taskQueue.active || !taskQueue.pending.length) return;
  const task = taskQueue.pending.shift();
  taskQueueRunning = true;
  taskQueue.active = task;
  taskQueue.status = 'running';
  task.startedAt = nowIso();
  task.status = 'running';
  task.taskRef.status = 'running';
  task.taskRef.startedAt = task.startedAt;
  appendLogs(task.taskRef, `[queue] 开始执行：${task.label}`);
  appendTaskQueueLog(`开始：${task.label}`);

  const child = spawn(process.execPath, task.args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE,
      ...task.env,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  task.child = child;
  task.taskRef.child = child;
  child.stdout.on('data', (chunk) => appendLogs(task.taskRef, chunk));
  child.stderr.on('data', (chunk) => appendLogs(task.taskRef, chunk));

  let timeout = null;
  let forceKill = null;
  let finished = false;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  };
  const finish = (result) => {
    if (finished) return;
    finished = true;
    cleanup();
    finishQueuedTask(task, result).catch((error) => {
      appendTaskQueueLog(`队列收尾异常：${error.message}`);
      taskQueueRunning = false;
      taskQueue.active = null;
      taskQueue.status = taskQueue.pending.length ? 'queued' : 'idle';
      setTimeout(processTaskQueue, 0).unref?.();
    });
  };

  timeout = setTimeout(() => {
    task.timedOut = true;
    task.status = 'resetting';
    task.taskRef.status = 'resetting';
    appendLogs(task.taskRef, `[watchdog] ${task.label} 超过 ${Math.round(task.timeoutMs / 1000)} 秒，发送 SIGTERM。`);
    appendTaskQueueLog(`超时重置：${task.label}。`);
    const cancelled = taskQueue.pending.splice(0);
    for (const pendingTask of cancelled) {
      pendingTask.status = 'cancelled';
      pendingTask.taskRef.status = 'cancelled';
      pendingTask.taskRef.finishedAt = nowIso();
      appendLogs(pendingTask.taskRef, `[watchdog] 当前任务超时，等待队列已自动清空。`);
    }
    if (cancelled.length) appendTaskQueueLog(`已自动清空 ${cancelled.length} 个等待任务。`);
    safeKill(child, 'SIGTERM');
    forceKill = setTimeout(() => {
      appendLogs(task.taskRef, `[watchdog] ${task.label} 未退出，发送 SIGKILL。`);
      safeKill(child, 'SIGKILL');
    }, TASK_KILL_GRACE_MS);
    forceKill.unref?.();
  }, task.timeoutMs);
  timeout.unref?.();

  child.once('error', (error) => finish({ code: 1, error }));
  child.once('close', (code, signal) => finish({ code, signal }));
}

function resetTaskQueue(reason = 'manual reset') {
  const active = taskQueue.active;
  if (active?.child) {
    active.timedOut = true;
    appendLogs(active.taskRef, `[watchdog] ${reason}，正在终止当前任务。`);
    safeKill(active.child, 'SIGTERM');
    setTimeout(() => safeKill(active.child, 'SIGKILL'), TASK_KILL_GRACE_MS).unref?.();
  }
  for (const task of taskQueue.pending.splice(0)) {
    task.status = 'cancelled';
    task.taskRef.status = 'cancelled';
    task.taskRef.finishedAt = nowIso();
    appendLogs(task.taskRef, `[queue] 已取消：${reason}`);
  }
  appendTaskQueueLog(`队列重置：${reason}`);
}

function runTaskQueueWatchdog() {
  const active = taskQueue.active;
  if (active?.child?.pid && !isPidAlive(active.child.pid)) {
    appendLogs(active.taskRef, '[watchdog] 子进程已不存在，自动重置任务状态。');
    finishQueuedTask(active, { code: 1, signal: 'missing', error: new Error('子进程已不存在') }).catch((error) => {
      appendTaskQueueLog(`watchdog 重置失败：${error.message}`);
    });
    return;
  }
  if (!active && taskQueueRunning) {
    appendTaskQueueLog('发现队列运行标记残留，自动恢复。');
    taskQueueRunning = false;
    taskQueue.status = taskQueue.pending.length ? 'queued' : 'idle';
    setTimeout(processTaskQueue, 0).unref?.();
  }
}

function startSync(from, to) {
  const key = `sync:${from}:${to}`;
  if (queuedTaskWithKey(key)) {
    throw new Error(`任务已在中心队列中：同步 ${from} -> ${to}`);
  }
  const task = {
    from,
    to,
    status: 'idle',
    phase: 'order-management',
    progressText: '等待中心任务队列执行',
    logs: [],
    requestedAt: nowIso(),
    rawTargetUrl: '',
  };
  activeSync = task;
  const rawTarget = kanbanRawSyncTarget();
  task.rawTargetUrl = rawTarget.label;
  if (rawTarget.label) appendLogs(task, `[server] Order Management 写入目标：${rawTarget.label}`);
  enqueueChildTask({
    key,
    label: `同步 ${from} -> ${to}`,
    taskRef: task,
    args: [path.join(NODE_ENTRY_ROOT, 'scripts/sync-pdd-to-feishu.mjs')],
    env: {
      ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE,
      ...rawTarget.env,
      PDD_DATE_FROM: from,
      PDD_DATE_TO: to,
      PDD_SELECT_YESTERDAY: 'false',
      PDD_AUTO_WAIT_FOR_LOGIN: 'true',
    },
    timeoutMs: SYNC_TIMEOUT_MS,
    onSuccess: async (syncTask) => {
      await refreshKanbanReviewAfterSync(syncTask, (line) => appendLogs(syncTask, line));
      syncTask.phase = 'completed';
      syncTask.progressText = 'Order Management 和 Kanban Review 已刷新';
    },
  });
  return task;
}

async function readReportConfig() {
  try {
    const text = await readFile(REPORT_CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch {
    return normalizeConfig(DEFAULT_REPORT_CONFIG);
  }
}

function normalizeConfig(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  if (!items.length) throw new Error('至少需要一条上报规则。');
  const heartbeatInput = config?.heartbeat || {};
  const notificationInput = config?.notification || {};
  const notification = normalizeNotificationConfig({
    ...notificationInput,
    adminGroup: notificationInput.adminGroup || heartbeatInput.feishuChatName,
    mentionNames: notificationInput.mentionNames?.length ? notificationInput.mentionNames : heartbeatInput.mentionNames,
  });
  const defaultHeartbeat = defaultHeartbeatConfig();
  const intervalMinutes = Number(heartbeatInput.intervalMinutes || defaultHeartbeat.intervalMinutes);
  return {
    schedulerEnabled: Boolean(config?.schedulerEnabled),
    heartbeat: {
      enabled: typeof heartbeatInput.enabled === 'boolean' ? heartbeatInput.enabled : defaultHeartbeat.enabled,
      intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : defaultHeartbeat.intervalMinutes,
      feishuChatName: notification.adminGroup || defaultHeartbeat.feishuChatName,
      mentionNames: notification.mentionNames.length ? notification.mentionNames : normalizeNameList(defaultHeartbeat.mentionNames),
    },
    notification,
    reservation: normalizeReservationConfig(config?.reservation || {}),
    scheduleMonitor: normalizeScheduleMonitorConfig(config?.scheduleMonitor || {}),
    violationCheck: normalizeViolationCheckConfig(config?.violationCheck || {}),
    items: items.map((item, index) => ({
      id: String(item.id || index + 1),
      region: String(item.region || item['区域'] || item['销售区域'] || '').trim(),
      warehouse: String(item.warehouse || item['仓库'] || item['仓组'] || '').trim(),
      groupName: String(item.groupName || item['群名'] || '').trim(),
      chatName: String(item.chatName || item['发送群名'] || item.groupName || item['群名'] || '').trim(),
      memberName: String(item.memberName || item['成员名'] || '').trim(),
      mentionNames: Array.isArray(item.mentionNames)
        ? item.mentionNames.map((name) => String(name).trim()).filter(Boolean)
        : normalizeNameList(item.mentionNames || item['@群成员'] || item.memberName || item['成员名'] || ''),
      sendTimes: normalizeConfigTimeList(item.sendTimes || item['发送时间']),
      cutoffTime: normalizeConfigTime(item.cutoffTime || item['截单时间']) || String(item.cutoffTime || '').trim(),
      topOfHour: enabledFromValue(item.topOfHour ?? item['是否整点'], false),
      enabled: enabledFromValue(item.enabled ?? item['状态(启/停)'] ?? item['状态'], false),
      wechatEnabled: typeof item.wechatEnabled === 'boolean' ? item.wechatEnabled : Boolean(item.wechatRoomName),
      wechatRoomName: String(item.wechatRoomName || '').trim(),
      wechatMentionNames: Array.isArray(item.wechatMentionNames)
        ? item.wechatMentionNames.map((name) => String(name).trim()).filter(Boolean)
        : normalizeNameList(item.wechatMentionNames || ''),
    })),
  };
}

async function saveReportConfig(config) {
  const normalized = normalizeConfig(config);
  await mkdir(path.dirname(REPORT_CONFIG_PATH), { recursive: true });
  await writeFile(REPORT_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  configureHeartbeatTimer(normalized.heartbeat);
  configureSchedulerTimer(normalized);
  return normalized;
}

function appendHeartbeatLog(message) {
  appendLogs(heartbeatMonitor, `[心跳] ${beijingTimestamp()} ${message}`);
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    const error = new Error(`Feishu API failed: HTTP ${response.status} ${body.msg || JSON.stringify(body)}`);
    error.code = body.code;
    error.logId = body.error?.log_id || '';
    throw error;
  }
  return body;
}

async function feishuTenantToken() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('尚未配置飞书 App ID 和 App Secret。');
  const body = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  return body.tenant_access_token;
}

async function findFeishuChat(token, chatName) {
  const targetName = String(chatName || '').trim();
  if (!targetName) throw new Error('未配置飞书群。');
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const body = await feishuJson(`https://open.feishu.cn/open-apis/im/v1/chats?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const matches = (body.data?.items || []).filter((chat) => chat.name === targetName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`找到多个同名飞书群：${targetName}，请改成唯一群名。`);
    pageToken = body.data?.has_more ? body.data.page_token : '';
  } while (pageToken);
  throw new Error(`飞书机器人不在群聊：${targetName}`);
}

async function findFeishuChatWithFallback(token, chatName, label = '飞书通知群') {
  const targetName = String(chatName || '').trim();
  try {
    return await findFeishuChat(token, targetName);
  } catch (primaryError) {
    const fallbackChatId = String(process.env.FEISHU_REPORT_CHAT_ID || '').trim();
    const fallbackChatName = String(process.env.FEISHU_REPORT_CHAT_NAME || '').trim();
    if (fallbackChatId) {
      return {
        chat_id: fallbackChatId,
        name: fallbackChatName || fallbackChatId,
        fallbackReason: `${label} ${targetName || '-'} 不可用，已使用 FEISHU_REPORT_CHAT_ID 兜底。`,
      };
    }
    if (fallbackChatName && fallbackChatName !== targetName) {
      try {
        const chat = await findFeishuChat(token, fallbackChatName);
        return {
          ...chat,
          fallbackReason: `${label} ${targetName || '-'} 不可用，已使用 FEISHU_REPORT_CHAT_NAME=${fallbackChatName} 兜底。`,
        };
      } catch (fallbackError) {
        throw new Error(`${label}配置错误：${primaryError.message}；兜底群 ${fallbackChatName} 也不可用：${fallbackError.message}`);
      }
    }
    throw new Error(`${label}配置错误：${primaryError.message}。请在页面里填写机器人已加入的飞书群名，或在 .env 配置 FEISHU_REPORT_CHAT_ID。`);
  }
}

async function findFeishuMember(token, chatId, mentionName) {
  const targetName = String(mentionName || '').trim();
  if (!targetName) throw new Error('心跳监控未配置 @成员。');
  let pageToken = '';
  const matches = [];
  do {
    const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const body = await feishuJson(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    matches.push(...(body.data?.items || []).filter((member) => member.name === targetName));
    pageToken = body.data?.has_more ? body.data.page_token : '';
  } while (pageToken);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`飞书群内有多个成员叫 ${targetName}，请改成唯一昵称。`);
  throw new Error(`飞书群内找不到成员：${targetName}`);
}

async function sendHeartbeatAlert(heartbeatConfig, failedChecks, allChecks) {
  const token = await feishuTenantToken();
  const chat = await findFeishuChatWithFallback(token, heartbeatConfig.feishuChatName, '心跳告警飞书群');
  const members = [];
  for (const name of heartbeatConfig.mentionNames) {
    members.push(await findFeishuMember(token, chat.chat_id, name));
  }
  const mentionNodes = members.flatMap((member) => [
    { tag: 'at', user_id: member.member_id, user_name: member.name },
    { tag: 'text', text: ' ' },
  ]);
  const content = {
    zh_cn: {
      title: '多多数字管家心跳告警',
      content: [
        [
          ...mentionNodes,
          { tag: 'text', text: `${beijingTimestamp()} 检测到登录异常` },
        ],
        ...failedChecks.map((check) => [{ tag: 'text', text: `${check.name}：${check.detail}` }]),
        [{ tag: 'text', text: `当前状态：${allChecks.map(formatHeartbeatCheckState).join('，')}` }],
      ],
    },
  };
  await feishuJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chat.chat_id, msg_type: 'post', content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { chatName: chat.name, mentionNames: members.map((member) => member.name), fallbackReason: chat.fallbackReason || '' };
}

function formatHeartbeatCheckState(check) {
  if (check.loggedIn === true) return `${check.name}已登录`;
  if (check.loggedIn === false) return `${check.name}未登录`;
  return `${check.name}检测异常`;
}

async function checkPddLoginStatus() {
  await loadDotEnv('.env', true);
  const storageStatePath = pddStorageStatePath(ROOT);
  const profileDir = path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile');
  try {
    const storageState = await loadPddStorageState(storageStatePath);
    if (!storageState) {
      if (await pathExists(profileDir)) {
        return {
          id: 'pdd',
          name: '拼多多',
          loggedIn: null,
          ok: false,
          alertable: false,
          detail: `未找到 PDD 登录态文件：${path.relative(ROOT, storageStatePath)}；已发现浏览器登录目录：${path.relative(ROOT, profileDir)}，请执行一次同步或上报来刷新登录态文件`,
          storageStatePath,
          profileDir,
        };
      }
      return {
        id: 'pdd',
        name: '拼多多',
        loggedIn: false,
        ok: false,
        detail: `未找到 PDD 登录态文件：${path.relative(ROOT, storageStatePath)}`,
        storageStatePath,
        profileDir,
      };
    }

    const loggedIn = pddStorageStateHasUsableCookies(storageState);
    return {
      id: 'pdd',
      name: '拼多多',
      loggedIn,
      ok: loggedIn,
      detail: loggedIn ? 'storageState 中存在可用 PDD Cookie' : 'storageState 中没有可用 PDD Cookie，请重新登录拼多多',
      storageStatePath,
      profileDir,
    };
  } catch (error) {
    return {
      id: 'pdd',
      name: '拼多多',
      loggedIn: null,
      ok: false,
      alertable: false,
      detail: `检测异常：${error.message}`,
      storageStatePath,
      profileDir,
    };
  }
}

function checkWechatLoginStatus() {
  if (!WEB_WECHAT_ENABLED) {
    if (desktopWechatSmokeState.ok === false) {
      return {
        id: 'desktopWechat',
        name: '桌面微信',
        loggedIn: null,
        ok: false,
        alertable: false,
        detail: `微信 App 上报 smoke test 未通过：${desktopWechatSmokeState.reason}`,
      };
    }
    return {
      id: 'desktopWechat',
      name: '桌面微信',
      loggedIn: true,
      ok: true,
      detail: '已切换为桌面微信 App 发送；启动检查不再检测 Web 微信 Chrome。',
    };
  }
  const status = wechatyBot.getStatus();
  const loggedIn = status.status === 'logged-in';
  return {
    id: 'wechat',
    name: '微信机器人',
    loggedIn,
    ok: loggedIn,
    detail: loggedIn ? `已登录：${status.loggedInUser || '-'}` : `未登录（当前状态：${status.status || '未知'}）`,
  };
}

function heartbeatIntervalMs(heartbeatConfig = defaultHeartbeatConfig()) {
  const minutes = Number(heartbeatConfig.intervalMinutes || 5);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000;
}

function scheduleHeartbeatCheck(delayMs = HEARTBEAT_INTERVAL_MS) {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatMonitor.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
  heartbeatTimer = setTimeout(() => {
    runHeartbeatCheck().catch((error) => appendHeartbeatLog(`检查异常：${error.message}`));
  }, delayMs);
  heartbeatTimer.unref?.();
}

function markHeartbeatStopped() {
  heartbeatMonitor.status = 'stopped';
  heartbeatMonitor.nextCheckAt = null;
  heartbeatMonitor.finishedAt = nowIso();
  heartbeatMonitor.lastResult = { ok: true, skipped: true, checkedAt: heartbeatMonitor.finishedAt, results: [] };
}

function configureHeartbeatTimer(heartbeatConfig = defaultHeartbeatConfig(), delayMs = HEARTBEAT_INTERVAL_MS) {
  if (!heartbeatConfig.enabled) {
    stopHeartbeatMonitor();
    markHeartbeatStopped();
    return;
  }
  scheduleHeartbeatCheck(delayMs);
}

async function runHeartbeatCheck({ manual = false } = {}) {
  if (heartbeatRunning) return heartbeatMonitor.lastResult || null;
  heartbeatRunning = true;
  heartbeatMonitor.status = 'running';
  heartbeatMonitor.startedAt = nowIso();
  heartbeatMonitor.error = null;
  let heartbeatConfig = defaultHeartbeatConfig();

  try {
    await loadDotEnv('.env', true);
    heartbeatConfig = (await readReportConfig()).heartbeat || defaultHeartbeatConfig();
    heartbeatMonitor.config = heartbeatConfig;
    if (!heartbeatConfig.enabled) {
      markHeartbeatStopped();
      return heartbeatMonitor.lastResult;
    }

    appendHeartbeatLog(WEB_WECHAT_ENABLED ? '开始检查拼多多和微信机器人登录状态。' : '开始检查拼多多登录状态和桌面微信发送通道。');
    const results = await Promise.all([
      checkPddLoginStatus(),
      Promise.resolve(checkWechatLoginStatus()),
    ]);
    const failedChecks = results.filter((check) => check.loggedIn === false);
    const indeterminateChecks = results.filter((check) => check.loggedIn == null);
    const checkedAt = nowIso();
    heartbeatMonitor.lastCheckedAt = checkedAt;
    heartbeatMonitor.lastResult = { ok: failedChecks.length === 0 && indeterminateChecks.length === 0, checkedAt, results };
    if (!failedChecks.length) {
      if (indeterminateChecks.length) {
        appendHeartbeatLog(`检测异常，不发送登录告警：${indeterminateChecks.map((check) => `${check.name}（${check.detail}）`).join('；')}。`);
        heartbeatMonitor.status = 'failed';
      } else {
        appendHeartbeatLog(WEB_WECHAT_ENABLED ? '检查通过：拼多多和微信均已登录。' : '检查通过：拼多多登录有效，桌面微信发送通道已启用。');
        heartbeatMonitor.status = 'completed';
      }
      return heartbeatMonitor.lastResult;
    }

    const latestHeartbeatConfig = (await readReportConfig()).heartbeat || defaultHeartbeatConfig();
    heartbeatConfig = latestHeartbeatConfig;
    heartbeatMonitor.config = latestHeartbeatConfig;
    if (!latestHeartbeatConfig.enabled) {
      appendHeartbeatLog('心跳监控已关闭，本次异常不发送告警。');
      markHeartbeatStopped();
      return heartbeatMonitor.lastResult;
    }

    appendHeartbeatLog(`发现未登录：${failedChecks.map((check) => `${check.name}（${check.detail}）`).join('；')}。`);
    if (indeterminateChecks.length) {
      appendHeartbeatLog(`检测异常不作为未登录告警：${indeterminateChecks.map((check) => `${check.name}（${check.detail}）`).join('；')}。`);
    }
    const alertResult = await sendHeartbeatAlert(latestHeartbeatConfig, failedChecks, results);
    if (alertResult.fallbackReason) appendHeartbeatLog(alertResult.fallbackReason);
    appendHeartbeatLog(`已发送飞书告警到 ${alertResult.chatName}，@${alertResult.mentionNames.join(', ')}。`);
    heartbeatMonitor.status = 'failed';
    return heartbeatMonitor.lastResult;
  } catch (error) {
    heartbeatMonitor.status = 'failed';
    heartbeatMonitor.error = error.message;
    appendHeartbeatLog(`告警失败：${error.message}`);
    return heartbeatMonitor.lastResult || { ok: false, checkedAt: nowIso(), results: [], error: error.message };
  } finally {
    heartbeatRunning = false;
    heartbeatMonitor.finishedAt = nowIso();
    if (heartbeatConfig.enabled) scheduleHeartbeatCheck(heartbeatIntervalMs(heartbeatConfig));
    else stopHeartbeatMonitor();
  }
}

async function startHeartbeatMonitor() {
  if (heartbeatTimer) return;
  const heartbeatConfig = (await readReportConfig()).heartbeat || defaultHeartbeatConfig();
  heartbeatMonitor.config = heartbeatConfig;
  if (!heartbeatConfig.enabled) {
    markHeartbeatStopped();
    return;
  }
  heartbeatMonitor.status = 'idle';
  scheduleHeartbeatCheck(10_000);
}

function stopHeartbeatMonitor() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatMonitor.nextCheckAt = null;
}

function startReport({ all = false, dryRun = false, ids = [], channel = 'both', source = 'manual', scheduledTime = '' } = {}) {
  const args = [path.join(NODE_ENTRY_ROOT, 'scripts/report-pdd-to-feishu.mjs'), '--once'];
  if (all) args.push('--all');
  if (dryRun) args.push('--dry-run');
  if (ids.length) args.push(`--ids=${ids.join(',')}`);
  args.push(`--channel=${channel}`);
  const key = source === 'scheduler'
    ? `scheduled-report:${channel}:${scheduledTime || beijingTimestamp().slice(0, 16)}`
    : `manual-report:${Date.now()}:${channel}:${ids.join(',')}:${dryRun ? 'dry-run' : 'send'}`;
  if (queuedTaskWithKey(key)) {
    throw new Error(`任务已在中心队列中：${source === 'scheduler' ? `定时微信群上报检查 (${channel})` : `手动上报 (${channel})`}`);
  }

  const task = {
    status: 'idle',
    logs: [],
    requestedAt: nowIso(),
    all,
    dryRun,
    ids,
    channel,
    source,
    scheduledTime,
  };
  activeReport = task;
  enqueueChildTask({
    key,
    label: source === 'scheduler' ? `定时微信群上报检查 (${channel})` : `手动上报 (${channel})`,
    taskRef: task,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE,
      WECHAT_BRIDGE_URL: LOCAL_WECHAT_BRIDGE_URL,
      ...(scheduledTime ? { PDD_REPORT_SCHEDULED_TIME: scheduledTime } : {}),
    },
    timeoutMs: REPORT_TIMEOUT_MS,
  });
  return task;
}

function startReservation({ dryRun = true, ids = [], includeDisabled = false, source = 'manual', scheduledTime = '' } = {}) {
  const args = [path.join(NODE_ENTRY_ROOT, 'scripts/create-pdd-delivery-appointment.mjs')];
  if (dryRun) args.push('--dry-run');
  else args.push('--commit');
  if (ids.length) args.push(`--ids=${ids.join(',')}`);
  if (includeDisabled) args.push('--include-disabled');
  const key = source === 'scheduler'
    ? `scheduled-reservation:${scheduledTime || beijingTimestamp().slice(0, 16)}`
    : `reservation:${Date.now()}:${ids.join(',')}:${dryRun ? 'dry-run' : 'commit'}`;
  if (queuedTaskWithKey(key)) {
    throw new Error(`任务已在中心队列中：预约送货${dryRun ? '演练' : '提交'}`);
  }

  const task = {
    status: 'idle',
    logs: [],
    requestedAt: nowIso(),
    dryRun,
    ids,
    includeDisabled,
    source,
    scheduledTime,
  };
  activeReservation = task;
  enqueueChildTask({
    key,
    label: source === 'scheduler' ? `定时预约送货${dryRun ? '演练' : '提交'}` : `预约送货${dryRun ? '演练' : '提交'}`,
    taskRef: task,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE,
      PDD_AUTO_WAIT_FOR_LOGIN: 'true',
    },
    timeoutMs: RESERVATION_TIMEOUT_MS,
  });
  return task;
}

function startScheduler() {
  if (activeScheduler?.status === 'running') return;
  activeScheduler = {
    status: 'running',
    logs: activeScheduler?.logs || [],
    startedAt: new Date().toISOString(),
  };
  appendLogs(activeScheduler, `[scheduler] ${beijingTimestamp()} 定时上报调度器已启动。`);
  scheduleSchedulerTick(1000);
}

function stopScheduler() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  activeScheduler = {
    status: 'stopped',
    logs: activeScheduler?.logs || [],
    finishedAt: new Date().toISOString(),
  };
  appendLogs(activeScheduler, `[scheduler] ${beijingTimestamp()} 定时上报调度器已停止。`);
}

function msUntilNextMinute() {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

function scheduleSchedulerTick(delayMs = msUntilNextMinute()) {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  if (activeScheduler?.status !== 'running') return;
  activeScheduler.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
  schedulerTimer = setTimeout(() => {
    runSchedulerTick().catch((error) => {
      appendLogs(activeScheduler, `[scheduler] ${beijingTimestamp()} 调度异常：${error.message}`);
      scheduleSchedulerTick();
    });
  }, delayMs);
  schedulerTimer.unref?.();
}

async function runSchedulerTick() {
  schedulerTimer = null;
  const reportConfig = await readReportConfig().catch((error) => {
    appendLogs(activeScheduler, `[scheduler] ${beijingTimestamp()} 读取配置失败：${error.message}`);
    return null;
  });
  if (!reportConfig || !scheduleConfigEnabled(reportConfig)) {
    stopScheduler();
    return;
  }

  const minuteKey = beijingTimestamp().slice(0, 16);
  const minuteTime = minuteKey.slice(11);
  if (minuteKey !== schedulerLastMinuteKey) {
    schedulerLastMinuteKey = minuteKey;
    const scheduledReportDue = reportConfig.schedulerEnabled
      && (reportConfig.items || []).some((item) => item.enabled
        && item.wechatEnabled
        && item.wechatRoomName
        && timeListIncludes(item.sendTimes, minuteTime));
    if (scheduledReportDue) {
      try {
        startReport({ channel: 'wechat', source: 'scheduler', scheduledTime: minuteTime });
        appendLogs(activeScheduler, `[scheduler] ${minuteKey} 已投递微信群定时上报检查到中心队列。`);
      } catch (error) {
        appendLogs(activeScheduler, `[scheduler] ${minuteKey} 微信群定时上报投递跳过：${error.message}`);
      }
    }
    const reservation = reportConfig.reservation || {};
    const reservationDue = reservation.enabled
      && (
        timeListIncludes(reservation.firstRunTimes, minuteTime)
        || (reservation.createLastAppointmentEnabled !== false && timeListIncludes(reservation.lastRunTimes, minuteTime))
      );
    if (reservationDue) {
      try {
        startReservation({
          dryRun: reservation.dryRun !== false,
          source: 'scheduler',
          scheduledTime: minuteKey,
        });
        appendLogs(activeScheduler, `[scheduler] ${minuteKey} 已投递预约送货任务到中心队列。`);
      } catch (error) {
        appendLogs(activeScheduler, `[scheduler] ${minuteKey} 预约送货投递跳过：${error.message}`);
      }
    }
    if (reportConfig.violationCheck?.enabled) {
      appendLogs(activeScheduler, `[scheduler] ${minuteKey} 违规检查配置已启用，但当前版本尚未开放执行器，未投递任务。`);
    }
  }
  scheduleSchedulerTick();
}

function configureSchedulerTimer(configOrEnabled) {
  const enabled = typeof configOrEnabled === 'boolean' ? configOrEnabled : scheduleConfigEnabled(configOrEnabled || {});
  if (enabled) startScheduler();
  else stopScheduler();
}

async function setSchedulerEnabled(enabled) {
  const config = await readReportConfig();
  config.schedulerEnabled = Boolean(enabled);
  await mkdir(path.dirname(REPORT_CONFIG_PATH), { recursive: true });
  await writeFile(REPORT_CONFIG_PATH, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
  configureSchedulerTimer(config);
  return config;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of wechatSSEClients) {
    try { res.write(payload); } catch {}
  }
}

wechatyBot.onScan((_qrcode, status) => {
  broadcastSSE('scan', { status });
});

wechatyBot.onLogin((user) => {
  broadcastSSE('login', { user: user.name() });
});

wechatyBot.onLogout(() => {
  broadcastSSE('logout', {});
});

const server = createServer(async (request, response) => {
  try {
    const requestPathname = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`).pathname;
    if (request.method === 'GET' && await servePublicAsset(requestPathname, response)) {
      return;
    }

    if (request.method === 'GET' && request.url === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/preflight') {
      sendJson(response, 200, await preflightChecks());
      return;
    }

    if (request.method === 'GET' && request.url === '/api/app-config') {
      sendJson(response, 200, { config: await readAppConfig() });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/app-config') {
      const { config } = await readJson(request);
      sendJson(response, 200, { ok: true, config: await saveAppConfig(config) });
      return;
    }

    if (request.method === 'GET' && APP_ROUTE_PATHS.has(requestPathname)) {
      const html = await readFile(path.join(WEB_DIR, 'index.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && requestPathname === '/kanban.html') {
      await serveKanbanHtml(response);
      return;
    }

    if (request.method === 'GET' && request.url === '/responsive-layout.mjs') {
      const script = await readFile(path.join(WEB_DIR, 'responsive-layout.mjs'));
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(script);
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/desktop-wechat-logs')) {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      const logs = await listDesktopWechatLogs();
      const requestedName = path.basename(url.searchParams.get('name') || '');
      const requestedLog = logs.find((item) => item.name === requestedName);
      const todayName = `wechat-desktop-automation-${beijingDateKey()}.log`;
      const current = requestedLog
        || logs.find((item) => item.name === todayName)
        || logs[0]
        || { name: todayName, date: beijingDateKey(), size: 0, updatedAt: '' };
      const lines = await readDesktopWechatLogLines(current.name);
      sendJson(response, 200, {
        logDir: LOG_DIR,
        logs,
        current,
        lines,
        previewLines: compactLogs(lines),
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/desktop-wechat-smoke') {
      if (WEB_WECHAT_ENABLED) await runDesktopWechatSmokeTest();
      else scheduleDesktopWechatSmokeTest();
      sendJson(response, 200, { smoke: desktopWechatSmokeState });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/desktop-wechat-smoke') {
      const state = await runDesktopWechatSmokeTest({ force: true });
      sendJson(response, state.ok ? 200 : 503, { smoke: state, error: state.ok ? '' : state.reason });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/status') {
      const externalJobLock = await readJobLockStatus({ root: ROOT, logDir: LOG_DIR }).catch(() => null);
      sendJson(response, 200, {
        features: {
          webWechatEnabled: WEB_WECHAT_ENABLED,
          desktopWechatEnabled: DESKTOP_WECHAT_ENABLED,
          wechatChannel: WEB_WECHAT_ENABLED ? 'wechaty' : 'desktop_wechat',
        },
        taskQueue: summarizeTaskQueue(),
        jobLock: externalJobLock ? {
          owner: externalJobLock.owner,
          pid: externalJobLock.pid,
          startedAt: externalJobLock.startedAt,
          description: externalJobLock.description,
        } : null,
        sync: summarizeTask(activeSync),
        report: summarizeTask(activeReport),
        reservation: summarizeTask(activeReservation),
        scheduler: summarizeTask(activeScheduler),
        heartbeat: summarizeTask(heartbeatMonitor),
        monitorNotification: summarizeTask(monitorNotificationQueue),
        desktopWechat: { smoke: desktopWechatSmokeState },
        wechat: wechatyBot.getStatus(),
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/heartbeat/run') {
      runHeartbeatCheck({ manual: true }).catch((error) => appendHeartbeatLog(`手动检查异常：${error.message}`));
      sendJson(response, 202, { status: 'running' });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/kanban-config') {
      sendJson(response, 200, await readKanbanConfig());
      return;
    }

    if (request.method === 'POST' && request.url === '/api/kanban-config') {
      const config = await saveKanbanConfig(await readJson(request));
      sendJson(response, 200, { ok: true, config });
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/kanban-data')) {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      sendJson(response, 200, await loadKanbanData({ forceRefresh: url.searchParams.get('refresh') === '1' }));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/report-config') {
      sendJson(response, 200, { path: path.relative(ROOT, REPORT_CONFIG_PATH), config: await readReportConfig() });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/report-config') {
      const { config } = await readJson(request);
      const saved = await saveReportConfig(config);
      sendJson(response, 200, { ok: true, path: path.relative(ROOT, REPORT_CONFIG_PATH), config: saved });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/report-scheduler') {
      const { enabled } = await readJson(request);
      const config = await setSchedulerEnabled(Boolean(enabled));
      sendJson(response, 200, { ok: true, config });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/report') {
      if (isQueueTaskActive(activeReport)) {
        sendJson(response, 409, { error: '已有上报任务在中心队列中。' });
        return;
      }
      const { all, dryRun, ids, channel } = await readJson(request);
      const normalizedChannel = ['both', 'feishu', 'wechat'].includes(channel) ? channel : 'both';
      const normalizedIds = Array.isArray(ids) ? ids.map(String) : [];
      if (normalizedChannel !== 'feishu') {
        await ensureDesktopWechatSmokeReady();
      }
      if (!FEISHU_REPORT_ENABLED && normalizedChannel !== 'wechat') {
        sendJson(response, 403, { error: '飞书分仓库上报当前已隐藏并停用。' });
        return;
      }
      if (normalizedChannel === 'wechat') {
        const reportConfig = await readReportConfig();
        const selected = (reportConfig.items || []).filter((item) => normalizedIds.includes(String(item.id)));
        const invalid = selected.filter((item) => !item.wechatEnabled || !String(item.wechatRoomName || '').trim());
        if (!selected.length || invalid.length) {
          const labels = invalid.map((item) => `#${item.id} ${item.warehouse || item.groupName || ''}`.trim());
          sendJson(response, 400, {
            error: labels.length
              ? `以下规则未启用微信上报或未填写微信群名：${labels.join('、')}`
              : '未找到要执行的微信上报规则。',
          });
          return;
        }
      }
      startReport({
        all: Boolean(all),
        dryRun: Boolean(dryRun),
        ids: normalizedIds,
        channel: normalizedChannel,
      });
      sendJson(response, 202, { status: activeReport.status, queueId: activeReport.queueId });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/reservation/run') {
      if (isQueueTaskActive(activeReservation)) {
        sendJson(response, 409, { error: '已有预约任务在中心队列中。' });
        return;
      }
      const { dryRun = true, ids, includeDisabled } = await readJson(request);
      const normalizedIds = Array.isArray(ids) ? ids.map(String) : [];
      if (!dryRun) {
        sendJson(response, 403, { error: '真实提交预约暂未开放，请先使用预约演练确认页面填写结果。' });
        return;
      }
      startReservation({
        dryRun: true,
        ids: normalizedIds,
        includeDisabled: Boolean(includeDisabled || normalizedIds.length),
      });
      sendJson(response, 202, { status: activeReservation.status, queueId: activeReservation.queueId });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/sync') {
      if (isQueueTaskActive(activeSync)) {
        sendJson(response, 409, { error: '已有同步任务在中心队列中。' });
        return;
      }
      const { from, to } = await readJson(request);
      if (!validDate(from) || !validDate(to) || from > to) {
        sendJson(response, 400, { error: '请选择有效的开始和结束日期。' });
        return;
      }
      startSync(from, to);
      sendJson(response, 202, { status: activeSync.status, queueId: activeSync.queueId, from, to });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/task-queue/reset') {
      resetTaskQueue('手动重置');
      sendJson(response, 202, { ok: true, taskQueue: summarizeTaskQueue() });
      return;
    }

    // WeChat (Wechaty) API endpoints

    if (request.method === 'GET' && request.url === '/api/wechat/status') {
      sendJson(response, 200, wechatyBot.getStatus());
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/wechat/qr-image')) {
      if (!WEB_WECHAT_ENABLED) {
        sendJson(response, 410, { error: disabledWechatStatus().reason });
        return;
      }
      if (!wechatyBot.qrData) {
        sendJson(response, 404, { error: 'WeChat QR code is not available' });
        return;
      }
      const QRCode = (await import('qrcode')).default;
      const image = await QRCode.toBuffer(wechatyBot.qrData, {
        type: 'png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': image.length,
      });
      response.end(image);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/wechat/qr') {
      if (!WEB_WECHAT_ENABLED) {
        sendJson(response, 410, { error: disabledWechatStatus().reason });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write(':\n\n');

      const current = wechatyBot.getStatus();
      if (current.qrAvailable && wechatyBot.qrData) {
        response.write(`event: scan\ndata: ${JSON.stringify({ status: 'scanning' })}\n\n`);
      } else if (current.status === 'logged-in') {
        response.write(`event: login\ndata: ${JSON.stringify({ user: current.loggedInUser })}\n\n`);
      }

      wechatSSEClients.add(response);
      request.on('close', () => wechatSSEClients.delete(response));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/wechat/start') {
      if (!WEB_WECHAT_ENABLED) {
        sendJson(response, 410, { error: disabledWechatStatus().reason, status: wechatyBot.getStatus() });
        return;
      }
      const current = wechatyBot.getStatus();
      if (current.status === 'logged-in' || current.status === 'scanning' || current.status === 'starting') {
        sendJson(response, 200, { ok: true, status: current.status });
        return;
      }
      if (current.status === 'error') await wechatyBot.stop();
      await wechatyBot.start();
      sendJson(response, 200, { ok: true, status: wechatyBot.getStatus().status });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/wechat/stop') {
      if (!WEB_WECHAT_ENABLED) {
        sendJson(response, 200, { ok: true, status: wechatyBot.getStatus().status });
        return;
      }
      await wechatyBot.stop();
      sendJson(response, 200, { ok: true, status: wechatyBot.getStatus().status });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/wechat/send') {
      const { roomName, text, imagePaths, mentionNames } = await readJson(request);
      if (!roomName) {
        sendJson(response, 400, { error: 'roomName is required' });
        return;
      }
      const result = WEB_WECHAT_ENABLED
        ? await wechatyBot.sendToRoom(
            roomName,
            text || '',
            Array.isArray(imagePaths) ? imagePaths : [],
            Array.isArray(mentionNames) ? mentionNames : [],
          )
        : await sendToDesktopWechat({ roomName, text, imagePaths, mentionNames });
      sendJson(response, 200, { ok: true, result });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDD Feishu Sync UI: http://127.0.0.1:${PORT}`);
});

setInterval(runTaskQueueWatchdog, 60_000).unref?.();

async function shutdown() {
  stopHeartbeatMonitor();
  stopScheduler();
  resetTaskQueue('服务退出');
  await wechatyBot.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

readReportConfig()
  .then((config) => {
    if (config.schedulerEnabled) startScheduler();
    startHeartbeatMonitor();
  })
  .catch((error) => {
    console.error(`读取上报配置失败：${error.message}`);
    startHeartbeatMonitor();
  });

if (WEB_WECHAT_ENABLED && process.env.WECHATY_AUTO_START === 'true') {
  wechatyBot.start().then(() => {
    console.log('Wechaty bot starting... scan QR code in the web UI.');
  }).catch((error) => {
    console.error(`Wechaty bot start failed: ${error.message}`);
  });
}
