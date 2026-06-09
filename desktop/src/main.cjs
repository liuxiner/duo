const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createRuntimeUpdater } = require('./runtime-update.cjs');

let mainWindow = null;
let serverProcess = null;
let runtimePort = 0;
let pendingUpdate = null;
let quitting = false;

function desktopPackage() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

const desktopPkg = desktopPackage();
const feedUrl = process.env.MAO_UPDATE_FEED_URL
  || desktopPkg.mao?.updateFeedUrl
  || '';
const updater = createRuntimeUpdater({ app, feedUrl, bundledVersion: app.getVersion() });

function bundledAppDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.resolve(__dirname, '..', '..');
}

function activeAppDir() {
  return updater.currentAppDir() || bundledAppDir();
}

function workspaceDir() {
  return path.join(app.getPath('userData'), 'workspace');
}

const CHROME_SERVICES = {
  pdd: {
    envKey: 'PDD_CDP_URL',
    defaultPort: 9222,
    candidatePorts: 12,
    profile: 'pdd-chrome',
    url: 'https://mc.pinduoduo.com/ddmc-mms/order/management',
  },
  wechat: {
    envKey: 'WECHATY_CDP_URL',
    defaultPort: 9333,
    candidatePorts: 12,
    profile: 'wechat-chrome',
    url: 'https://wx.qq.com/',
  },
};

function chromeExecutable() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function readWorkspaceEnv() {
  const envPath = path.join(workspaceDir(), '.env');
  try {
    return fs.readFileSync(envPath, 'utf8');
  } catch {
    return '';
  }
}

function readWorkspaceConfigValue(key) {
  const match = readWorkspaceEnv().match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'm'));
  if (!match) return '';
  const raw = match[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\''))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function writeWorkspaceConfig(partial) {
  const envPath = path.join(workspaceDir(), '.env');
  const source = readWorkspaceEnv();
  const lines = source ? source.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(partial, match[1])) return line;
    const key = match[1];
    seen.add(key);
    return `${key}=${JSON.stringify(String(partial[key] || ''))}`;
  });
  for (const [key, value] of Object.entries(partial)) {
    if (!seen.has(key)) next.push(`${key}=${JSON.stringify(String(value || ''))}`);
  }
  fs.writeFileSync(envPath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
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

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function candidatePorts(definition, configuredUrl) {
  const ports = new Set();
  try {
    const parsed = configuredUrl ? new URL(configuredUrl) : null;
    if (parsed && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      ports.add(parsed.port ? Number(parsed.port) : definition.defaultPort);
    }
  } catch {}
  for (let offset = 0; offset < definition.candidatePorts; offset += 1) {
    ports.add(definition.defaultPort + offset);
  }
  return [...ports].filter((port) => Number.isInteger(port) && port > 0);
}

async function resolveChromeServiceEndpoint(service) {
  const definition = CHROME_SERVICES[service];
  if (!definition) throw new Error('未知 Chrome 服务。');
  const configuredUrl = readWorkspaceConfigValue(definition.envKey) || `http://127.0.0.1:${definition.defaultPort}`;
  const directProbe = await probeChromeEndpoint(configuredUrl);
  if (directProbe.ok) {
    return { url: configuredUrl, port: Number(new URL(configuredUrl).port || definition.defaultPort), reused: true, changed: false };
  }

  for (const port of candidatePorts(definition, configuredUrl)) {
    const candidateUrl = `http://127.0.0.1:${port}`;
    if (candidateUrl === configuredUrl) continue;
    const probe = await probeChromeEndpoint(candidateUrl);
    if (!probe.ok) continue;
    writeWorkspaceConfig({ [definition.envKey]: candidateUrl });
    return { url: candidateUrl, port, reused: true, changed: true };
  }

  for (const port of candidatePorts(definition, configuredUrl)) {
    if (await isPortFree(port)) {
      const candidateUrl = `http://127.0.0.1:${port}`;
      writeWorkspaceConfig({ [definition.envKey]: candidateUrl });
      return { url: candidateUrl, port, reused: false, changed: candidateUrl !== configuredUrl };
    }
  }

  throw new Error(`未找到可用的 ${definition.envKey} 本地端口。`);
}

async function launchChromeService(service) {
  const definition = CHROME_SERVICES[service];
  if (!definition) throw new Error('未知 Chrome 服务。');
  const executable = chromeExecutable();
  if (!executable) throw new Error('未找到 Google Chrome，请先安装 Chrome。');
  const resolved = await resolveChromeServiceEndpoint(service);
  if (resolved.reused) return { ok: true, port: resolved.port, url: resolved.url, reused: true, changed: resolved.changed };
  const profileDir = path.join(workspaceDir(), '.chrome', definition.profile);
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executable, [
    `--remote-debugging-port=${resolved.port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    definition.url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  writeWorkspaceConfig({ [definition.envKey]: resolved.url });
  return { ok: true, port: resolved.port, url: resolved.url, profileDir, reused: false, changed: resolved.changed };
}

function ensureWorkspace() {
  const root = workspaceDir();
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const envFile = path.join(root, '.env');
  const example = path.join(activeAppDir(), '.env.example');
  if (!fs.existsSync(envFile) && fs.existsSync(example)) fs.copyFileSync(example, envFile);
}

function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForHealth(port, timeout = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.once('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - started >= timeout) reject(new Error('本地服务启动超时。'));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function stopServer() {
  if (!serverProcess) return Promise.resolve();
  const child = serverProcess;
  serverProcess = null;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startServer(allowFallback = true) {
  await stopServer();
  ensureWorkspace();
  runtimePort = await findPort();
  const appRoot = activeAppDir();
  const entry = path.join(appRoot, 'web', 'server.mjs');
  const logs = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logs, 'service.log'), { flags: 'a' });
  const child = spawn(process.execPath, [entry], {
    cwd: workspaceDir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(runtimePort),
      MAO_APP_ROOT: appRoot,
      MAO_WORKSPACE_PATH: workspaceDir(),
      WECHAT_BRIDGE_URL: `http://127.0.0.1:${runtimePort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.once('exit', (code, signal) => {
    if (serverProcess === child) serverProcess = null;
    if (!quitting) logStream.write(`[desktop] service exited code=${code} signal=${signal}\n`);
  });
  try {
    await waitForHealth(runtimePort);
  } catch (error) {
    child.kill('SIGTERM');
    if (allowFallback && updater.currentAppDir() && updater.disableCurrent(error.message)) {
      return startServer(false);
    }
    throw error;
  }
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:status', status);
}

async function createWindow() {
  await startServer();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 640,
    minHeight: 560,
    title: '多多数字管家',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${runtimePort}`);
  setTimeout(() => ipcMain.emit('runtime:auto-check'), 5000);
}

ipcMain.handle('desktop:get-info', () => ({
  shellVersion: app.getVersion(),
  runtimeVersion: updater.currentVersion(),
  workspacePath: workspaceDir(),
  updateConfigured: Boolean(feedUrl),
}));

ipcMain.handle('desktop:open-workspace', async () => {
  await shell.openPath(workspaceDir());
});

ipcMain.handle('desktop:launch-chrome-service', (_event, service) => launchChromeService(service));

ipcMain.handle('runtime:check', async () => {
  sendUpdateStatus({ state: 'checking' });
  try {
    pendingUpdate = await updater.check();
    sendUpdateStatus(pendingUpdate.available
      ? { state: 'available', ...pendingUpdate }
      : { state: 'up-to-date', ...pendingUpdate });
    return pendingUpdate;
  } catch (error) {
    sendUpdateStatus({ state: 'error', message: error.message });
    throw error;
  }
});

ipcMain.handle('runtime:download', async () => {
  if (!pendingUpdate?.available) throw new Error('请先检查更新。');
  const version = await updater.download(pendingUpdate, (received, total) => {
    sendUpdateStatus({ state: 'downloading', received, total });
  });
  sendUpdateStatus({ state: 'ready', version });
  return { version };
});

ipcMain.handle('runtime:apply', async () => {
  await startServer();
  await mainWindow.loadURL(`http://127.0.0.1:${runtimePort}`);
  pendingUpdate = null;
  return { runtimeVersion: updater.currentVersion() };
});

ipcMain.on('runtime:auto-check', () => {
  if (!feedUrl) return;
  updater.check().then((result) => {
    pendingUpdate = result;
    if (result.available) sendUpdateStatus({ state: 'available', ...result });
  }).catch(() => {});
});

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('多多数字管家启动失败', error.message);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  void stopServer();
});
