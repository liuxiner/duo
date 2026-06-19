import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function loadDotEnv(file = process.env.ENV_FILE || '.env') {
  let text;
  try {
    text = await readFile(path.resolve(root, file), 'utf8');
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

async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    const error = new Error(`HTTP ${response.status} ${body.msg || JSON.stringify(body)}`);
    error.body = body;
    throw error;
  }
  return body;
}

function extractSpreadsheetToken(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/\/sheets\/([A-Za-z0-9]+)/);
  return match?.[1] || '';
}

function extractWikiNodeToken(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  return match?.[1] || '';
}

async function tenantToken() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('Missing FEISHU_APP_ID or FEISHU_APP_SECRET.');
  const body = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!body.tenant_access_token) throw new Error('Feishu did not return tenant_access_token.');
  return body.tenant_access_token;
}

async function resolveSpreadsheet(sourceUrl, token) {
  const directToken = extractSpreadsheetToken(sourceUrl);
  if (directToken) return { spreadsheetToken: directToken, via: 'sheet-url' };

  const wikiNodeToken = extractWikiNodeToken(sourceUrl);
  if (!wikiNodeToken) throw new Error('empty Feishu URL');
  const search = new URLSearchParams({ token: wikiNodeToken });
  const body = await feishuJson(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?${search}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const node = body.data?.node || body.data || {};
  const objectType = String(node.obj_type || node.objType || '').toLowerCase();
  const spreadsheetToken = node.obj_token || node.objToken;
  if (objectType && !['sheet', 'spreadsheet'].includes(objectType)) {
    throw new Error(`wiki node type is ${objectType}, not sheet/spreadsheet`);
  }
  if (!spreadsheetToken) throw new Error(`cannot resolve spreadsheet token from wiki node ${wikiNodeToken}`);
  return { spreadsheetToken, via: 'wiki', objectType: objectType || 'sheet' };
}

async function listSheets(spreadsheetToken, token) {
  const body = await feishuJson(
    `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return body.data?.sheets || body.data?.items || [];
}

function sourceChecks() {
  return [
    ['raw', process.env.FEISHU_KANBAN_RAW_URL || process.env.FEISHU_WIKI_URL],
    ['rules', process.env.FEISHU_KANBAN_RULES_URL],
    ['manual', process.env.FEISHU_KANBAN_MANUAL_URL],
    ['review', process.env.FEISHU_KANBAN_REVIEW_URL],
  ].filter(([, url]) => String(url || '').trim());
}

await loadDotEnv();

try {
  const token = await tenantToken();
  console.log('OK feishu tenant token');
  const checks = sourceChecks();
  if (!checks.length) throw new Error('No FEISHU_KANBAN_* URLs configured.');
  for (const [label, sourceUrl] of checks) {
    const resolved = await resolveSpreadsheet(sourceUrl, token);
    const sheets = await listSheets(resolved.spreadsheetToken, token);
    console.log(`OK ${label}: ${sheets.length} sheet(s), via ${resolved.via}`);
  }
  console.log('Feishu kanban auth check passed.');
} catch (error) {
  const cause = error.cause
    ? ` (${error.cause.code || error.cause.name || 'cause'}: ${error.cause.message || error.cause})`
    : '';
  console.error(`Feishu kanban auth check failed: ${error.message}${cause}`);
  process.exitCode = 1;
}
