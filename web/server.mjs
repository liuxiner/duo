import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_DIR, '..');
const PORT = Number(process.env.PORT || 4173);
let activeSync = null;

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Request body is too large.');
  }
  return JSON.parse(body || '{}');
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

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

  activeSync = { from, to, status: 'running', logs, startedAt: new Date().toISOString() };
  const append = (chunk) => {
    logs.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    append(error.message);
    activeSync.status = 'failed';
    activeSync.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    activeSync.status = code === 0 ? 'completed' : 'failed';
    activeSync.exitCode = code;
    activeSync.finishedAt = new Date().toISOString();
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      const html = await readFile(path.join(WEB_DIR, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/status') {
      sendJson(response, 200, activeSync || { status: 'idle', logs: [] });
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

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDD Feishu Sync UI: http://127.0.0.1:${PORT}`);
});
