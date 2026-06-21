import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePddBrowserContext, createPddBrowserContext, loginAndSavePddStorageState } from '../pdd-automation/auth/login.mjs';
import {
  pddStorageStatePath,
  querySupplierInboundPunishment,
  writeJsonSnapshot,
} from '../pdd-automation/clients/pdd-client.mjs';
import { withJobLock } from './job-lock.mjs';
import { closeBlockingModals } from './pdd-page-tools.mjs';

const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || process.cwd());
const VIOLATION_URL = 'https://mc.pinduoduo.com/ddmc-mms/violation';
const DEFAULT_TASK_TIMEOUT_MS = 8 * 60 * 1000;

const FIELD_ALIASES = {
  region: ['销售区域', 'areaName', 'regionName', 'provinceName', 'areaName2'],
  warehouseGroup: ['仓组名称', 'warehouseGroupName', 'warehouseGroup', 'groupName', '仓组'],
  warehouse: ['仓库', 'warehouseName', 'warehouse'],
  violationId: ['违规编号', 'punishmentId', 'punishId', 'punishmentNo', 'violationId', 'violateId', 'id'],
  violationType: ['违规类型', 'punishmentTypeName', 'punishTypeName', 'typeName', 'ruleName'],
  salesDate: ['销售日期', 'saleDate', 'bizDate', 'businessDate'],
  createdAt: ['违规发起时间', 'createTime', 'createdAt', 'punishmentTime', 'gmtCreate'],
  amount: ['违规金额', 'amount', 'punishAmount', 'fineAmount', 'penaltyAmount'],
  progress: ['处理进度', 'appealStatusName', 'statusName', 'processStatusName', 'progress'],
  action: ['操作', 'action', 'operation'],
};

async function loadDotEnv(file = '.env') {
  let text = '';
  try { text = await readFile(path.resolve(ROOT, file), 'utf8'); } catch { return; }
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

function positiveDurationMs(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.round(next) : fallback;
}

function splitList(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(/[,，、\s]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function beijingDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function beijingTimestamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function readReportConfig() {
  const configPath = path.resolve(ROOT, process.env.PDD_REPORT_CONFIG_PATH || 'data/report-config.json');
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function violationConfig(config) {
  const input = config.violationCheck || {};
  return {
    onlyPendingAppeals: input.onlyPendingAppeals !== false,
    notifyWhenEmpty: Boolean(input.notifyWhenEmpty),
  };
}

function wechatNotifyTarget(config = {}) {
  const notification = config.notification || {};
  const roomName = String(process.env.PDD_NOTIFY_WECHAT_ROOM_NAME || notification.wechatRoomName || '').trim();
  const mentionNames = splitList(process.env.PDD_NOTIFY_WECHAT_MENTION_NAMES || notification.wechatMentionNames || '');
  const enabled = process.env.PDD_NOTIFY_WECHAT_ENABLED !== 'false' && Boolean(roomName);
  return { enabled, roomName, mentionNames };
}

async function sendWechatNotification(config, text) {
  const target = wechatNotifyTarget(config);
  if (!target.enabled) {
    console.log('违规检查微信群通知已关闭或未配置微信群名，跳过发送。');
    return null;
  }
  const bridgeUrl = process.env.WECHAT_BRIDGE_URL || 'http://127.0.0.1:4173';
  console.log(`准备发送违规检查结果到微信群 ${target.roomName}${target.mentionNames.length ? `，@${target.mentionNames.join(', ')}` : ''}。`);
  const response = await fetch(`${bridgeUrl}/api/wechat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName: target.roomName,
      text,
      imagePaths: [],
      mentionNames: target.mentionNames,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`违规检查微信群通知失败：${body.error || response.statusText}`);
  const sent = body.result || {};
  console.log(`违规检查结果已发送到微信群 ${sent.roomName || target.roomName}${(sent.mentionNames || target.mentionNames).length ? `，已@${(sent.mentionNames || target.mentionNames).join(', ')}` : ''}。`);
  return sent;
}

function flattenObject(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, raw] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) flattenObject(raw, nextKey, output);
    else output[nextKey] = raw;
  }
  return output;
}

function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'number' && value > 1_000_000_000_000) return beijingTimestamp(new Date(value));
  return normalizeText(value);
}

function pickValue(flat, aliases) {
  const entries = Object.entries(flat);
  for (const alias of aliases) {
    const normalizedAlias = String(alias).toLowerCase();
    const exact = entries.find(([key]) => key.split('.').at(-1) === alias);
    if (exact) return formatValue(exact[1]);
    const matched = entries.find(([key]) => key.toLowerCase().includes(normalizedAlias));
    if (matched) return formatValue(matched[1]);
  }
  return '';
}

function normalizeViolationRow(raw) {
  const flat = flattenObject(raw);
  const row = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    row[field] = pickValue(flat, aliases);
  }
  row.raw = raw;
  row.summaryText = Object.values(row)
    .filter((value) => typeof value === 'string')
    .join(' ');
  return row;
}

function findArrayCandidates(value, pathParts = [], output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      output.push({ path: pathParts.join('.'), value });
    }
    for (const item of value) findArrayCandidates(item, pathParts, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    findArrayCandidates(child, [...pathParts, key], output);
  }
  return output;
}

function scoreArrayCandidate(candidate) {
  const pathScore = /punish|violation|appeal|list|records|rows/i.test(candidate.path) ? 10 : 0;
  const sample = candidate.value.slice(0, 5).map((item) => JSON.stringify(item)).join('\n');
  const contentScore = /违规|申诉|appeal|punish|violation|处理/.test(sample) ? 20 : 0;
  return pathScore + contentScore + Math.min(candidate.value.length, 20);
}

function extractApiRows(body) {
  const candidates = findArrayCandidates(body)
    .filter((candidate) => candidate.value.length)
    .sort((a, b) => scoreArrayCandidate(b) - scoreArrayCandidate(a));
  const best = candidates[0];
  if (!best) return { rows: [], sourcePath: '' };
  return {
    rows: best.value
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeViolationRow),
    sourcePath: best.path,
  };
}

async function queryApiViolations(context) {
  const bodies = [
    { pageNo: 1, pageSize: 100 },
    { pageNumber: 1, pageSize: 100 },
    { page: 1, size: 100 },
  ];
  const errors = [];
  for (const body of bodies) {
    try {
      const response = await querySupplierInboundPunishment(context, body);
      const extracted = extractApiRows(response);
      if (extracted.rows.length) {
        return { rows: extracted.rows, source: `api:${extracted.sourcePath || 'unknown'}`, raw: response, errors };
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { rows: [], source: 'api', raw: null, errors };
}

async function scrapeUiViolations(page) {
  await page.goto(VIOLATION_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await closeBlockingModals(page);
  await page.waitForFunction(() => /违规|处理进度|违规编号/.test(document.body.innerText || '') || document.querySelector('table'), null, { timeout: 30_000 }).catch(() => {});
  const rows = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const expectedHeaders = ['销售区域', '仓组名称', '仓库', '违规编号', '违规类型', '销售日期', '违规发起时间', '违规金额', '处理进度', '操作'];
    const tables = Array.from(document.querySelectorAll('table')).filter(isVisible);
    for (const table of tables) {
      const headerText = normalize(table.querySelector('thead')?.innerText || '');
      if (!/违规|处理进度|违规编号/.test(headerText)) continue;
      const headers = Array.from(table.querySelectorAll('thead th'))
        .map((th) => normalize(th.innerText || th.textContent))
        .filter(Boolean);
      const usableHeaders = headers.length ? headers : expectedHeaders;
      return Array.from(table.querySelectorAll('tbody tr'))
        .filter((tr) => isVisible(tr) && normalize(tr.innerText))
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) => normalize(td.innerText || td.textContent));
          const raw = {};
          cells.forEach((value, index) => {
            raw[usableHeaders[index] || `字段${index + 1}`] = value;
          });
          return raw;
        });
    }
    return [];
  });
  return rows.map(normalizeViolationRow);
}

function isPendingRow(row) {
  const text = normalizeText(`${row.progress} ${row.action} ${row.summaryText}`);
  if (!text) return true;
  if (/已处理|已完成|关闭|撤销|无需|通过|完结|不成立|成功/.test(text) && !/待|处理中|修改|申诉|申述|补充|材料/.test(text)) return false;
  return /待|处理中|平台处理|修改|申诉|申述|补充|材料|审核|进行中/.test(text) || !/已处理|已完成|关闭|撤销/.test(text);
}

function formatViolationReport(rows, { checkedAt, onlyPending }) {
  if (!rows.length) {
    return [
      '违规检查上报',
      `检查时间：${checkedAt}`,
      onlyPending ? '暂无待处理违规' : '暂无违规记录',
    ].join('\n');
  }
  const lines = [
    '违规检查上报',
    `检查时间：${checkedAt}`,
    `${onlyPending ? '待处理违规' : '违规记录'}：${rows.length} 项`,
  ];
  rows.slice(0, 20).forEach((row, index) => {
    lines.push(`${index + 1}. ${row.violationType || '违规'} ${row.violationId ? `#${row.violationId}` : ''}`.trim());
    lines.push(`仓组：${row.warehouseGroup || '-'}${row.warehouse ? ` / ${row.warehouse}` : ''}`);
    lines.push(`销售日期：${row.salesDate || '-'}，金额：${row.amount || '-'}`);
    lines.push(`进度：${row.progress || row.action || '-'}`);
  });
  if (rows.length > 20) lines.push(`...另有 ${rows.length - 20} 项，完整内容见运行日志快照`);
  return lines.join('\n');
}

await loadDotEnv();
const config = await readReportConfig();
const cfg = {
  cdpUrl: process.env.PDD_CDP_URL || 'http://127.0.0.1:9222',
  profileDir: path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile'),
  browserChannel: process.env.PDD_BROWSER_CHANNEL || 'chrome',
  chromiumSandbox: process.env.PDD_CHROMIUM_SANDBOX === 'true',
  headless: process.env.PDD_HEADLESS === 'true',
  waitForLogin: true,
  autoWaitForLogin: process.env.PDD_AUTO_WAIT_FOR_LOGIN !== 'false',
  loginWaitMs: Number(process.env.PDD_LOGIN_WAIT_MS || 180000),
  storageStatePath: pddStorageStatePath(ROOT),
  pddUrl: VIOLATION_URL,
};

let browser;
let context;
const taskTimeoutMs = positiveDurationMs(process.env.PDD_VIOLATION_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS);
let watchdog = null;
try {
  watchdog = setTimeout(async () => {
    console.error(`违规检查任务超过 ${Math.round(taskTimeoutMs / 1000)} 秒仍未结束，判定为超时失败。`);
    try {
      await closePddBrowserContext(browser, context);
    } catch (error) {
      console.error(`违规检查超时后关闭浏览器失败：${error.message}`);
    }
    process.exit(1);
  }, taskTimeoutMs);
  watchdog.unref?.();

  await withJobLock('violation-check', async () => {
    ({ browser, context } = await createPddBrowserContext(cfg));
    const { page } = await loginAndSavePddStorageState(cfg, context);
    const checkedAt = beijingTimestamp();
    const checkConfig = violationConfig(config);
    const apiResult = await queryApiViolations(context);
    if (apiResult.errors.length) console.log(`违规 API 探测失败：${apiResult.errors.join('；')}`);
    let rows = apiResult.rows;
    let source = apiResult.source;
    if (!rows.length) {
      rows = await scrapeUiViolations(page);
      source = 'ui';
    }
    const filteredRows = checkConfig.onlyPendingAppeals ? rows.filter(isPendingRow) : rows;
    const snapshotPath = path.resolve(ROOT, 'data/violations', `pdd-violations-${beijingDateKey()}-${Date.now()}.json`);
    await writeJsonSnapshot(snapshotPath, {
      checkedAt,
      source,
      totalRows: rows.length,
      reportedRows: filteredRows.length,
      onlyPendingAppeals: checkConfig.onlyPendingAppeals,
      rows: filteredRows,
    });
    console.log(`违规检查完成：来源 ${source}，共 ${rows.length} 条，通知 ${filteredRows.length} 条。`);
    console.log(`违规检查快照：${snapshotPath}`);
    if (!filteredRows.length && !checkConfig.notifyWhenEmpty) {
      console.log('违规检查无待通知记录，且未启用空结果通知，跳过微信群发送。');
      return;
    }
    await sendWechatNotification(config, formatViolationReport(filteredRows, {
      checkedAt,
      onlyPending: checkConfig.onlyPendingAppeals,
    }));
  }, { root: ROOT });
} finally {
  if (watchdog) clearTimeout(watchdog);
  await closePddBrowserContext(browser, context);
}
