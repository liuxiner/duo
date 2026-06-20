import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, 'dist');
const ENV_PATH = path.resolve(process.env.KANBAN_ENV_PATH || path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || process.env.KANBAN_PORT || 4173);
const CONFIG_FIELDS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_KANBAN_RAW_URL',
  'FEISHU_KANBAN_RULES_URL',
  'FEISHU_KANBAN_MANUAL_URL',
  'FEISHU_KANBAN_REVIEW_URL',
  'FEISHU_KANBAN_REFERENCE_URL',
  'FEISHU_KANBAN_WRITEBACK',
  'FEISHU_KANBAN_MANUAL_SYNC',
];
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function loadDotEnv(filePath = ENV_PATH, override = false) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
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

function envValue(value) {
  return JSON.stringify(String(value || ''));
}

async function readEnvConfig(fields) {
  await loadDotEnv(ENV_PATH, true);
  return Object.fromEntries(fields.map((key) => [key, process.env[key] || '']));
}

async function saveEnvConfig(input, fields) {
  let text = '';
  try {
    text = await readFile(ENV_PATH, 'utf8');
  } catch {}
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
  await mkdir(path.dirname(ENV_PATH), { recursive: true });
  await writeFile(ENV_PATH, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  return values;
}

function truthyConfig(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

async function importKanbanDataModule() {
  const candidates = [
    path.join(ROOT, 'server', 'kanban-data.mjs'),
    path.resolve(ROOT, '..', 'web', 'kanban-data.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate));
  }
  throw new Error('缺少 kanban-data.mjs，无法读取飞书 sheets。请先运行 npm run build 或使用完整仓库。');
}

await loadDotEnv(ENV_PATH, true);
const { KANBAN_DEFAULTS, loadKanbanData } = await importKanbanDataModule();

function kanbanConfigFromEnv(values) {
  return {
    serviceMode: true,
    dataUrl: '/api/kanban-data',
    appId: values.FEISHU_APP_ID || '',
    hasAppSecret: Boolean(values.FEISHU_APP_SECRET),
    authReady: Boolean(values.FEISHU_APP_ID && values.FEISHU_APP_SECRET),
    rawUrl: values.FEISHU_KANBAN_RAW_URL || KANBAN_DEFAULTS.rawSourceUrl,
    rulesUrl: values.FEISHU_KANBAN_RULES_URL || KANBAN_DEFAULTS.rulesSourceUrl,
    manualUrl: values.FEISHU_KANBAN_MANUAL_URL || KANBAN_DEFAULTS.manualInputUrl,
    reviewUrl: values.FEISHU_KANBAN_REVIEW_URL || KANBAN_DEFAULTS.reviewTargetUrl,
    referenceUrl: values.FEISHU_KANBAN_REFERENCE_URL || '',
    writebackEnabled: truthyConfig(values.FEISHU_KANBAN_WRITEBACK, true),
    manualSyncEnabled: truthyConfig(values.FEISHU_KANBAN_MANUAL_SYNC, true),
  };
}

async function readKanbanConfig() {
  return kanbanConfigFromEnv(await readEnvConfig(CONFIG_FIELDS));
}

async function saveKanbanConfig(input) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(input || {}, 'appId')) updates.FEISHU_APP_ID = input.appId;
  if (typeof input?.appSecret === 'string' && input.appSecret.trim()) updates.FEISHU_APP_SECRET = input.appSecret;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'rawUrl')) updates.FEISHU_KANBAN_RAW_URL = input.rawUrl;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'rulesUrl')) updates.FEISHU_KANBAN_RULES_URL = input.rulesUrl;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'manualUrl')) updates.FEISHU_KANBAN_MANUAL_URL = input.manualUrl;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'reviewUrl')) updates.FEISHU_KANBAN_REVIEW_URL = input.reviewUrl;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'referenceUrl')) updates.FEISHU_KANBAN_REFERENCE_URL = input.referenceUrl;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'writebackEnabled')) {
    updates.FEISHU_KANBAN_WRITEBACK = input.writebackEnabled ? 'true' : 'false';
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'manualSyncEnabled')) {
    updates.FEISHU_KANBAN_MANUAL_SYNC = input.manualSyncEnabled ? 'true' : 'false';
  }
  return kanbanConfigFromEnv(await saveEnvConfig(updates, CONFIG_FIELDS));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function sendFile(response, filePath) {
  const body = await readFile(filePath);
  const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

function staticPath(requestPathname) {
  const pathname = requestPathname === '/' ? '/index.html' : requestPathname;
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const filePath = path.resolve(DIST_DIR, relativePath);
  return filePath === DIST_DIR || filePath.startsWith(`${DIST_DIR}${path.sep}`) ? filePath : null;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

    if (request.method === 'GET' && url.pathname === '/api/kanban-config') {
      sendJson(response, 200, await readKanbanConfig());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/kanban-config') {
      const config = await saveKanbanConfig(await readJson(request));
      sendJson(response, 200, { ok: true, config });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/kanban-data') {
      const payload = await loadKanbanData({
        forceRefresh: url.searchParams.get('refresh') === '1' || url.searchParams.has('t'),
        forceWriteback: url.searchParams.get('writeback') === '1',
      });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    const filePath = staticPath(url.pathname);
    if (!filePath || !existsSync(filePath)) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200);
      response.end();
      return;
    }
    await sendFile(response, filePath);
  } catch (error) {
    sendJson(response, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kanban service: http://127.0.0.1:${PORT}`);
  console.log(`Config: ${ENV_PATH}`);
});
