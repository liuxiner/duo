import { exec } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.FEISHU_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.FEISHU_BRIDGE_PORT || 8787);
const COMMAND_TEMPLATE = process.env.FEISHU_CLI_COMMAND || '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.cache', 'feishu-export');

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function toCsv(values) {
  return values.map((row) => row.map((cell) => {
    const text = String(cell ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCommand(payload, jsonPath, csvPath) {
  if (!COMMAND_TEMPLATE) return '';

  const replacements = {
    json: shellQuote(jsonPath),
    csv: shellQuote(csvPath),
    url: shellQuote(payload.url),
    sheet: shellQuote(payload.sheetName || ''),
    range: shellQuote(payload.range || ''),
  };

  return COMMAND_TEMPLATE.replace(/\{(json|csv|url|sheet|range)\}/g, (_, key) => replacements[key]);
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function handleExport(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `Invalid JSON: ${error.message}` });
    return;
  }

  if (!payload.url || !Array.isArray(payload.values)) {
    sendJson(res, 400, { ok: false, error: 'Expected JSON with url and values.' });
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `export-${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `export-${stamp}.csv`);

  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(csvPath, toCsv(payload.values), 'utf8');

  const command = buildCommand(payload, jsonPath, csvPath);
  if (!command) {
    sendJson(res, 501, {
      ok: false,
      error: 'FEISHU_CLI_COMMAND is not configured.',
      jsonPath,
      csvPath,
      example: 'FEISHU_CLI_COMMAND="feishu excel write --url {url} --sheet {sheet} --range {range} --file {csv}" node feishu-cli-bridge.mjs',
    });
    return;
  }

  try {
    const result = await runCommand(command);
    sendJson(res, 200, { ok: true, jsonPath, csvPath, command, ...result });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
      jsonPath,
      csvPath,
      command,
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/feishu/excel') {
    handleExport(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Feishu CLI bridge listening on http://${HOST}:${PORT}/feishu/excel`);
  if (!COMMAND_TEMPLATE) {
    console.log('FEISHU_CLI_COMMAND is not set. Exports will be saved as JSON/CSV but not uploaded.');
  }
});
