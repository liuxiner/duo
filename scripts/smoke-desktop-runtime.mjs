import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const root = process.cwd();
const runtimeRoot = path.join(root, 'desktop', 'resources', 'runtime');
const workspaceRoot = path.join(root, 'dist', '.runtime-smoke-workspace');
const serverPath = path.join(runtimeRoot, 'web', 'server.mjs');
const port = Number(process.env.MAO_RUNTIME_SMOKE_PORT || 43000 + Math.floor(Math.random() * 10000));
const expectWebWechatRuntime = process.platform === 'win32'
  || process.env.MAO_EXPECT_WEB_WECHAT_RUNTIME === 'true'
  || process.env.MAO_ENABLE_WEB_WECHAT === 'true';

function assertRuntimePath(relativePath) {
  const fullPath = path.join(runtimeRoot, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Desktop runtime smoke failed: missing ${relativePath}`);
  }
}

function assertRuntimeFiles() {
  assertRuntimePath('package.json');
  assertRuntimePath('web/server.mjs');
  assertRuntimePath('scripts/report-pdd-to-feishu.mjs');
  if (!expectWebWechatRuntime) return;
  assertRuntimePath('scripts/wechaty-bot.mjs');
  assertRuntimePath('node_modules/file-box/package.json');
  assertRuntimePath('node_modules/puppeteer/package.json');
  assertRuntimePath('node_modules/wechaty/package.json');
  assertRuntimePath('node_modules/wechaty-puppet-wechat/package.json');
}

async function waitForRuntime(child, output) {
  const url = `http://127.0.0.1:${port}/api/wechat/status`;
  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (output.exit) {
      throw new Error(
        `Desktop runtime server exited early: code=${output.exit.code} signal=${output.exit.signal}\n`
        + `stdout:\n${output.stdout}\n\nstderr:\n${output.stderr}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      const status = JSON.parse(text);
      return status;
    } catch (error) {
      lastError = error.message;
      await wait(500);
    }
  }
  child.kill();
  throw new Error(
    `Desktop runtime smoke failed: ${url} did not become healthy. Last error: ${lastError}\n`
    + `stdout:\n${output.stdout}\n\nstderr:\n${output.stderr}`,
  );
}

async function stopRuntime(child, output) {
  if (output.exit) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(2000),
  ]);
  if (!output.exit) child.kill('SIGKILL');
}

assertRuntimeFiles();
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(workspaceRoot, { recursive: true });

const output = { stdout: '', stderr: '', exit: null };
const child = spawn(process.execPath, [serverPath], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MAO_APP_ROOT: runtimeRoot,
    MAO_LOG_DIR: path.join(workspaceRoot, 'logs'),
    MAO_WORKSPACE_PATH: workspaceRoot,
    PORT: String(port),
    WECHATY_AUTO_START: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { output.stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { output.stderr += chunk.toString(); });
child.on('exit', (code, signal) => { output.exit = { code, signal }; });

try {
  const status = await waitForRuntime(child, output);
  console.log(`Desktop runtime smoke passed on port ${port}: wechat=${status.status || 'unknown'}`);
} finally {
  await stopRuntime(child, output);
  await rm(workspaceRoot, { recursive: true, force: true });
}
