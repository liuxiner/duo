import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WechatyBot } from '../scripts/wechaty-bot.mjs';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_DIR, '..');
const PORT = Number(process.env.PORT || 4173);
const REPORT_CONFIG_PATH = path.resolve(ROOT, process.env.PDD_REPORT_CONFIG_PATH || 'data/report-config.json');
let activeSync = null;
let activeReport = null;
let activeScheduler = null;
const wechatyBot = new WechatyBot({ name: 'pdd-wechaty-bot' });
const wechatSSEClients = new Set();

const DEFAULT_REPORT_CONFIG = {
  schedulerEnabled: false,
  items: [
    { id: '1', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['06:00', '07:00', '08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '2', region: '浙江省', warehouse: '杭州仓组', groupName: '杭州交仓', chatName: '杭州交仓', memberName: '翱翔巍澜', mentionNames: ['翱翔巍澜'], sendTimes: ['12:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
    { id: '3', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '4', region: '浙江省', warehouse: '宁波仓组', groupName: '安如山~宁波中泓北港云仓', chatName: '安如山~宁波中泓北港云仓', memberName: '8', mentionNames: ['8'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
    { id: '5', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '20:00'], cutoffTime: '23:00', topOfHour: true, enabled: true },
    { id: '6', region: '浙江省', warehouse: '温州仓组', groupName: '杭州安如山—温州诚达云仓', chatName: '杭州安如山—温州诚达云仓', memberName: '诚达云仓王俊13339809298', mentionNames: ['诚达云仓王俊13339809298'], sendTimes: ['12:00', '13:00', '19:00'], cutoffTime: '23:00', topOfHour: false, enabled: true },
  ],
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
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

function summarizeTask(task) {
  if (!task) return { status: 'idle', logs: [], previewLogs: [] };
  const previewLogs = compactLogs(task.logs);
  const lastDate = [...task.logs].reverse().find((line) => /\d{4}-\d{2}-\d{2}/.test(line))?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const { child, ...safeTask } = task;
  return { ...safeTask, previewLogs, lastDate };
}

const SYNC_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function startSync(from, to) {
  const logs = [];
  const child = spawn(process.execPath, ['scripts/sync-pdd-to-feishu.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PDD_DATE_FROM: from,
      PDD_DATE_TO: to,
      PDD_SELECT_YESTERDAY: 'false',
      PDD_AUTO_WAIT_FOR_LOGIN: 'true',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  activeSync = { from, to, status: 'running', logs, startedAt: new Date().toISOString(), child };
  const append = (chunk) => {
    logs.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const timeout = setTimeout(() => {
    append(`[server] Sync timed out after ${SYNC_TIMEOUT_MS / 1000}s, killing process.`);
    child.kill('SIGKILL');
  }, SYNC_TIMEOUT_MS);

  const cleanup = () => clearTimeout(timeout);

  child.on('error', (error) => {
    cleanup();
    append(error.message);
    activeSync.status = 'failed';
    activeSync.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    cleanup();
    activeSync.status = code === 0 ? 'completed' : 'failed';
    activeSync.exitCode = code;
    activeSync.finishedAt = new Date().toISOString();
  });
}

async function readReportConfig() {
  try {
    const text = await readFile(REPORT_CONFIG_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return DEFAULT_REPORT_CONFIG;
  }
}

function normalizeConfig(config) {
  const items = Array.isArray(config?.items) ? config.items : [];
  if (!items.length) throw new Error('至少需要一条上报规则。');
  return {
    schedulerEnabled: Boolean(config.schedulerEnabled),
    items: items.map((item, index) => ({
      id: String(item.id || index + 1),
      region: String(item.region || '').trim(),
      warehouse: String(item.warehouse || '').trim(),
      groupName: String(item.groupName || '').trim(),
      chatName: String(item.chatName || '').trim(),
      memberName: String(item.memberName || '').trim(),
      mentionNames: Array.isArray(item.mentionNames) ? item.mentionNames.map((name) => String(name).trim()).filter(Boolean) : [],
      sendTimes: Array.isArray(item.sendTimes) ? item.sendTimes.map((time) => String(time).trim()).filter(Boolean) : [],
      cutoffTime: String(item.cutoffTime || '').trim(),
      topOfHour: Boolean(item.topOfHour),
      enabled: Boolean(item.enabled),
      wechatEnabled: Boolean(item.wechatEnabled),
      wechatRoomName: String(item.wechatRoomName || '').trim(),
      wechatMentionNames: Array.isArray(item.wechatMentionNames) ? item.wechatMentionNames.map((name) => String(name).trim()).filter(Boolean) : [],
    })),
  };
}

async function saveReportConfig(config) {
  const normalized = normalizeConfig(config);
  const previous = await readReportConfig();
  if (previous.schedulerEnabled && normalized.schedulerEnabled) {
    throw new Error('定时上报开启时不能修改配置，请先关闭定时上报。');
  }
  await mkdir(path.dirname(REPORT_CONFIG_PATH), { recursive: true });
  await writeFile(REPORT_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function appendLogs(target, chunk) {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  target.logs.push(...lines);
  if (target.logs.length > 500) target.logs.splice(0, target.logs.length - 500);
}

function startReport({ all = false, dryRun = false, ids = [] } = {}) {
  const logs = [];
  const args = ['scripts/report-pdd-to-feishu.mjs', '--once'];
  if (all) args.push('--all');
  if (dryRun) args.push('--dry-run');
  if (ids.length) args.push(`--ids=${ids.join(',')}`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const task = { status: 'running', logs, startedAt: new Date().toISOString(), all, dryRun, ids, child };
  activeReport = task;
  child.stdout.on('data', (chunk) => appendLogs(task, chunk));
  child.stderr.on('data', (chunk) => appendLogs(task, chunk));
  child.on('error', (error) => {
    appendLogs(task, error.message);
    task.status = 'failed';
    task.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    task.status = code === 0 ? 'completed' : 'failed';
    task.exitCode = code;
    task.finishedAt = new Date().toISOString();
    delete task.child;
  });
}

function startScheduler() {
  if (activeScheduler?.status === 'running') return;
  const child = spawn(process.execPath, ['scripts/report-pdd-to-feishu.mjs'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  activeScheduler = { status: 'running', logs: [], startedAt: new Date().toISOString() };
  activeScheduler.child = child;
  child.stdout.on('data', (chunk) => appendLogs(activeScheduler, chunk));
  child.stderr.on('data', (chunk) => appendLogs(activeScheduler, chunk));
  child.on('error', (error) => {
    appendLogs(activeScheduler, error.message);
    activeScheduler.status = 'failed';
    activeScheduler.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    if (activeScheduler?.child === child) {
      activeScheduler.status = code === 0 ? 'stopped' : 'failed';
      activeScheduler.exitCode = code;
      activeScheduler.finishedAt = new Date().toISOString();
      delete activeScheduler.child;
    }
  });
}

function stopScheduler() {
  if (activeScheduler?.child) {
    activeScheduler.child.kill('SIGTERM');
    activeScheduler.status = 'stopped';
    activeScheduler.finishedAt = new Date().toISOString();
    delete activeScheduler.child;
  } else {
    activeScheduler = { status: 'stopped', logs: activeScheduler?.logs || [], finishedAt: new Date().toISOString() };
  }
}

async function setSchedulerEnabled(enabled) {
  const config = await readReportConfig();
  config.schedulerEnabled = Boolean(enabled);
  await mkdir(path.dirname(REPORT_CONFIG_PATH), { recursive: true });
  await writeFile(REPORT_CONFIG_PATH, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
  if (enabled) startScheduler();
  else stopScheduler();
  return config;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of wechatSSEClients) {
    try { res.write(payload); } catch {}
  }
}

wechatyBot.onScan((qrcode, status) => {
  broadcastSSE('scan', { qrcode, status });
});

wechatyBot.onLogin((user) => {
  broadcastSSE('login', { user: user.name() });
});

wechatyBot.onLogout(() => {
  broadcastSSE('logout', {});
});

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      const html = await readFile(path.join(WEB_DIR, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/status') {
      sendJson(response, 200, {
        sync: summarizeTask(activeSync),
        report: summarizeTask(activeReport),
        scheduler: summarizeTask(activeScheduler),
        wechat: wechatyBot.getStatus(),
      });
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
      if (activeReport?.status === 'running') {
        sendJson(response, 409, { error: '已有上报任务正在运行。' });
        return;
      }
      const { all, dryRun, ids } = await readJson(request);
      startReport({ all: Boolean(all), dryRun: Boolean(dryRun), ids: Array.isArray(ids) ? ids.map(String) : [] });
      sendJson(response, 202, { status: 'running' });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/sync') {
      if (activeSync?.status === 'running') {
        sendJson(response, 409, { error: '已有同步任务正在运行。' });
        return;
      }
      const { from, to } = await readJson(request);
      if (!validDate(from) || !validDate(to) || from > to) {
        sendJson(response, 400, { error: '请选择有效的开始和结束日期。' });
        return;
      }
      startSync(from, to);
      sendJson(response, 202, { status: 'running', from, to });
      return;
    }

    // WeChat (Wechaty) API endpoints

    if (request.method === 'GET' && request.url === '/api/wechat/status') {
      sendJson(response, 200, wechatyBot.getStatus());
      return;
    }

    if (request.method === 'GET' && request.url === '/api/wechat/qr') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write(':\n\n');

      const current = wechatyBot.getStatus();
      if (current.qrAvailable && wechatyBot.qrData) {
        response.write(`event: scan\ndata: ${JSON.stringify({ qrcode: wechatyBot.qrData, status: 'scanning' })}\n\n`);
      } else if (current.status === 'logged-in') {
        response.write(`event: login\ndata: ${JSON.stringify({ user: current.loggedInUser })}\n\n`);
      }

      wechatSSEClients.add(response);
      request.on('close', () => wechatSSEClients.delete(response));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/wechat/start') {
      const current = wechatyBot.getStatus();
      if (current.status === 'logged-in' || current.status === 'scanning' || current.status === 'starting') {
        sendJson(response, 200, { ok: true, status: current.status });
        return;
      }
      await wechatyBot.start();
      sendJson(response, 200, { ok: true, status: wechatyBot.getStatus().status });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/wechat/stop') {
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
      await wechatyBot.sendToRoom(
        roomName,
        text || '',
        Array.isArray(imagePaths) ? imagePaths : [],
        Array.isArray(mentionNames) ? mentionNames : [],
      );
      sendJson(response, 200, { ok: true });
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

readReportConfig()
  .then((config) => {
    if (config.schedulerEnabled) startScheduler();
  })
  .catch((error) => {
    console.error(`读取上报配置失败：${error.message}`);
  });

if (process.env.WECHATY_AUTO_START === 'true') {
  wechatyBot.start().then(() => {
    console.log('Wechaty bot starting... scan QR code in the web UI.');
  }).catch((error) => {
    console.error(`Wechaty bot start failed: ${error.message}`);
  });
}
