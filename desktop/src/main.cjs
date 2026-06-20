const { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
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
let serviceWatchdogTimer = null;
let serviceHealthFailures = 0;

const DEFAULT_SERVICE_START_TIMEOUT_MS = process.platform === 'win32' ? 90_000 : 45_000;
const WECHAT_DESKTOP_AUTOMATION_TIMEOUT_MS = 45_000;
const WECHAT_DESKTOP_AUTOMATION_LOCK_TTL_MS = 5 * 60 * 1000;
const SERVICE_WATCHDOG_INTERVAL_MS = 60_000;
const SERVICE_WATCHDOG_MAX_FAILURES = 3;

function desktopPackage() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

const desktopPkg = desktopPackage();
const feedUrl = process.env.MAO_UPDATE_FEED_URL
  || desktopPkg.mao?.updateFeedUrl
  || '';
const updater = createRuntimeUpdater({ app, feedUrl, bundledVersion: app.getVersion() });
const DESKTOP_WECHAT_ENABLED = process.platform === 'darwin' || process.platform === 'win32';

function bundledAppDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.resolve(__dirname, '..', '..');
}

function activeAppDir() {
  return updater.currentAppDir() || bundledAppDir();
}

function workspaceDir() {
  return path.join(app.getPath('userData'), 'workspace');
}

function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function serviceLogPath() {
  return path.join(logsDir(), 'service.log');
}

function wechatDesktopAutomationLockPath() {
  return path.join(logsDir(), 'wechat-desktop-automation.lock');
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

function readWechatDesktopAutomationLock() {
  const lockPath = wechatDesktopAutomationLockPath();
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  const startedAtMs = Date.parse(lock.startedAt || '');
  const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : WECHAT_DESKTOP_AUTOMATION_LOCK_TTL_MS + 1;
  if (ageMs > WECHAT_DESKTOP_AUTOMATION_LOCK_TTL_MS || !isPidAlive(lock.pid)) {
    try { fs.unlinkSync(lockPath); } catch {}
    return null;
  }
  return lock;
}

function acquireWechatDesktopAutomationLock(owner, args = []) {
  const existing = readWechatDesktopAutomationLock();
  if (existing) {
    throw new Error(`桌面微信自动化正在运行：${existing.owner || 'unknown'}，请稍后再试。`);
  }
  fs.mkdirSync(logsDir(), { recursive: true });
  const lock = {
    pid: process.pid,
    owner,
    args: args.map((arg) => String(arg || '').slice(0, 80)),
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(wechatDesktopAutomationLockPath(), JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const racedLock = readWechatDesktopAutomationLock();
      throw new Error(`桌面微信自动化正在运行：${racedLock?.owner || 'unknown'}，请稍后再试。`);
    }
    throw error;
  }
  return () => {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(wechatDesktopAutomationLockPath(), 'utf8'));
    } catch {}
    if (current?.pid === lock.pid && current?.startedAt === lock.startedAt) {
      try { fs.unlinkSync(wechatDesktopAutomationLockPath()); } catch {}
    }
  };
}

const WEB_WECHAT_CHROME_SERVICE = {
  envKey: 'WECHATY_CDP_URL',
  defaultPort: 9333,
  candidatePorts: 12,
  profile: 'wechat-chrome',
  url: 'https://wx.qq.com/',
};

const PDD_CHROME_SERVICE = {
  envKey: 'PDD_CDP_URL',
  defaultPort: 9222,
  candidatePorts: 12,
  profile: 'pdd-chrome',
  url: 'https://mc.pinduoduo.com/ddmc-mms/order/management',
};

function chromeServices() {
  return {
    pdd: PDD_CHROME_SERVICE,
    ...(isWechatyChannel() ? { wechat: WEB_WECHAT_CHROME_SERVICE } : {}),
  };
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function existingChromeExecutable(candidate) {
  const normalized = String(candidate || '').trim().replace(/^"(.+)"$/, '$1');
  if (!normalized) return '';
  const candidates = [normalized];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(normalized, 'chrome.exe'),
      path.join(normalized, 'Application', 'chrome.exe'),
      path.join(normalized, 'Bin', 'chrome.exe'),
    );
  }
  for (const executable of candidates) {
    try {
      if (fs.existsSync(executable) && fs.statSync(executable).isFile()) return executable;
    } catch {}
  }
  return '';
}

function windowsChromeRegistryCandidates() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  const candidates = [];
  for (const key of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 2500 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:\(Default\)|\(默认\))\s+REG_\w+\s+(.+?)\s*$/i);
        if (match) candidates.push(match[1]);
      }
    } catch {}
  }
  return candidates;
}

function windowsChromePathCandidates() {
  try {
    return execFileSync('where.exe', ['chrome.exe'], { encoding: 'utf8', windowsHide: true, timeout: 2500 })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function windowsChromeExecutableCandidates() {
  const localAppData = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  const installRoots = [
    process.env.PROGRAMFILES || 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    localAppData,
  ];
  const installCandidates = installRoots.flatMap((root) => [
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'Google', 'Chrome', 'Bin', 'chrome.exe'),
  ]);
  return uniqueValues([
    process.env.MAO_CHROME_PATH,
    process.env.PDD_CHROME_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    ...installCandidates,
    ...windowsChromeRegistryCandidates(),
    ...windowsChromePathCandidates(),
  ]);
}

function chromeExecutable() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? windowsChromeExecutableCandidates()
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  for (const candidate of candidates) {
    const executable = existingChromeExecutable(candidate);
    if (executable) return executable;
  }
  return '';
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

function truthyConfig(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function normalizeWechatChannel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['desktop', 'desktop_wechat', 'wechat_app', 'app'].includes(text)) return 'desktop_wechat';
  if (['wechaty', 'web', 'web_wechat', 'webwechat'].includes(text)) return 'wechaty';
  return '';
}

function webWechatRuntimeAvailable() {
  return fs.existsSync(path.join(activeAppDir(), 'scripts', 'wechaty-bot.mjs'));
}

function configuredWechatChannel() {
  const explicit = normalizeWechatChannel(readWorkspaceConfigValue('MAO_WECHAT_CHANNEL') || process.env.MAO_WECHAT_CHANNEL);
  if (explicit) return explicit;
  const desktopWechat = readWorkspaceConfigValue('MAO_USE_DESKTOP_WECHAT') || process.env.MAO_USE_DESKTOP_WECHAT;
  if (truthyConfig(desktopWechat, false)) return 'desktop_wechat';
  if (process.env.MAO_ENABLE_WEB_WECHAT === 'true' && webWechatRuntimeAvailable()) return 'wechaty';
  if (readWorkspaceConfigValue('MAO_WECHAT_EXE_PATH') || process.env.MAO_WECHAT_EXE_PATH) return 'desktop_wechat';
  return process.platform === 'win32' && webWechatRuntimeAvailable() ? 'wechaty' : 'desktop_wechat';
}

function isWechatyChannel() {
  return configuredWechatChannel() === 'wechaty';
}

function isDesktopWechatChannel() {
  return configuredWechatChannel() === 'desktop_wechat';
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
  const definition = chromeServices()[service];
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
  if (service === 'wechat' && isDesktopWechatChannel()) {
    return launchDesktopWechatApp();
  }
  const definition = chromeServices()[service];
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

function windowsWechatRegistryCandidates() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WeChat.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WeChat.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WeChat.exe',
  ];
  const candidates = [];
  for (const key of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 2500 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:\(Default\)|\(默认\))\s+REG_\w+\s+(.+?)\s*$/i);
        if (match) candidates.push(match[1]);
      }
    } catch {}
  }
  return candidates;
}

function windowsWechatPathCandidates() {
  const candidates = [];
  for (const name of ['Weixin.exe', 'WeChat.exe']) {
    try {
      candidates.push(...execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 2500 })
        .split(/\r?\n/)
        .filter(Boolean));
    } catch {}
  }
  return candidates;
}

function expandWechatExecutableCandidate(candidate) {
  const value = String(candidate || '').trim();
  if (!value) return [];
  const candidates = [value];
  if (path.basename(value).toLowerCase() === 'wexin.exe') {
    candidates.push(path.join(path.dirname(value), 'Weixin.exe'));
  }
  return candidates;
}

function windowsWechatExecutableCandidates() {
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return uniqueValues([
    readWorkspaceConfigValue('MAO_WECHAT_EXE_PATH'),
    process.env.MAO_WECHAT_EXE_PATH,
    path.join(programFiles, 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(programFiles, 'Tencent', 'WeChat', 'WeChat.exe'),
    path.join(programFilesX86, 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(programFilesX86, 'Tencent', 'WeChat', 'WeChat.exe'),
    path.join(localAppData, 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(localAppData, 'Tencent', 'WeChat', 'WeChat.exe'),
    path.join(localAppData, 'Programs', 'Tencent', 'Weixin', 'Weixin.exe'),
    path.join(localAppData, 'Programs', 'Tencent', 'WeChat', 'WeChat.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'Weixin.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'WeChat.exe'),
    ...windowsWechatRegistryCandidates(),
    ...windowsWechatPathCandidates(),
  ].flatMap(expandWechatExecutableCandidate));
}

function wechatExecutableStatus() {
  if (process.platform === 'darwin') {
    const appPath = '/Applications/WeChat.app';
    return { installed: fs.existsSync(appPath), path: appPath };
  }
  if (process.platform === 'win32') {
    const executable = windowsWechatExecutableCandidates().find((candidate) => fs.existsSync(candidate)) || '';
    return { installed: Boolean(executable), path: executable };
  }
  return { installed: false, path: '' };
}

function launchDesktopWechatApp() {
  if (!DESKTOP_WECHAT_ENABLED) throw new Error(`当前系统暂不支持桌面微信自动化：${process.platform}`);
  const wechat = wechatExecutableStatus();
  if (!wechat.installed) throw new Error('未找到桌面微信，请先安装并登录 WeChat。');
  const command = process.platform === 'darwin' ? 'open' : wechat.path;
  const args = process.platform === 'darwin' ? ['-a', 'WeChat'] : [];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return {
    ok: true,
    app: 'desktop_wechat',
    path: wechat.path,
  };
}

function wechatDesktopAutomationHelperPath() {
  const executable = process.platform === 'win32' ? 'mao-wechat-automation.ps1' : 'mao-wechat-automation';
  return path.join(activeAppDir(), 'bin', executable);
}

function checkWechatDesktopAutomationHelper() {
  const helperPath = wechatDesktopAutomationHelperPath();
  if (!fs.existsSync(helperPath)) {
    return {
      installed: false,
      path: helperPath,
      error: '桌面微信自动化 helper 不存在，请重新打包或更新客户端。',
    };
  }
  return { installed: true, path: helperPath, error: '' };
}

function desktopAppAccessibilityTrusted(prompt = false) {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

function desktopWechatAutomationStatus() {
  const wechat = wechatExecutableStatus();
  const helper = checkWechatDesktopAutomationHelper();
  if (!DESKTOP_WECHAT_ENABLED) {
    return {
      platform: process.platform,
      supported: false,
      implemented: false,
      disabled: true,
      disabledReason: `当前系统暂不支持桌面微信自动化：${process.platform}`,
      accessibilityTrusted: true,
      permissionRequired: false,
      wechatInstalled: wechat.installed,
      wechatPath: wechat.path,
      helperInstalled: helper.installed,
      helperPath: helper.path,
      helperError: helper.error || '',
    };
  }
  return {
    platform: process.platform,
    supported: true,
    implemented: true,
    accessibilityTrusted: desktopAppAccessibilityTrusted(false),
    permissionRequired: process.platform === 'darwin',
    wechatInstalled: wechat.installed,
    wechatPath: wechat.path,
    helperInstalled: helper.installed,
    helperPath: helper.path,
    helperError: helper.error || '',
  };
}

async function requestDesktopWechatAutomationPermissions() {
  if (!DESKTOP_WECHAT_ENABLED) return desktopWechatAutomationStatus();
  if (process.platform === 'darwin') {
    fs.mkdirSync(logsDir(), { recursive: true });
    const helper = checkWechatDesktopAutomationHelper();
    const appTrustedBefore = desktopAppAccessibilityTrusted(false);
    appendServiceLog(serviceLogPath(), `[desktop-wechat-permission] request started appTrustedBefore=${appTrustedBefore} helperInstalled=${helper.installed} helperPath=${helper.path}`);
    const appTrustedAfterPrompt = desktopAppAccessibilityTrusted(true);
    appendServiceLog(serviceLogPath(), `[desktop-wechat-permission] app prompt requested appTrustedAfterPrompt=${appTrustedAfterPrompt}`);
    if (helper.installed) {
      try {
        const helperResult = await runWechatDesktopAutomationHelper(['--check-permission', '--prompt'], 10_000, 'permission');
        appendServiceLog(serviceLogPath(), `[desktop-wechat-permission] helper prompt stdout=${JSON.stringify(helperResult.stdout.trim())} stderr=${JSON.stringify(helperResult.stderr.trim())}`);
      } catch (error) {
        appendServiceLog(serviceLogPath(), `[desktop-wechat-permission] helper prompt failed ${error.message}`);
      }
    }
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    appendServiceLog(serviceLogPath(), '[desktop-wechat-permission] opened macOS Accessibility settings');
  }
  return desktopWechatAutomationStatus();
}

function normalizeAutomationText(value, fallback = '') {
  return String(value || fallback).trim();
}

function desktopWechatEnv() {
  const exePath = readWorkspaceConfigValue('MAO_WECHAT_EXE_PATH') || process.env.MAO_WECHAT_EXE_PATH || '';
  return exePath ? { MAO_WECHAT_EXE_PATH: exePath } : {};
}

function helperLogPreview(value, maxLength = 1200) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength}>` : text;
}

function runNodeRuntimeScript(scriptPath, args, timeoutMs = WECHAT_DESKTOP_AUTOMATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: workspaceDir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MAO_APP_ROOT: activeAppDir(),
        MAO_WORKSPACE_PATH: workspaceDir(),
        MAO_LOG_DIR: logsDir(),
        ...desktopWechatEnv(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`桌面微信自动化超时（${Math.round(timeoutMs / 1000)} 秒）。`));
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
      else reject(new Error((stderr || stdout || `脚本退出 code=${code} signal=${signal}`).trim()));
    });
  });
}

function runWechatDesktopAutomationHelper(args, timeoutMs = WECHAT_DESKTOP_AUTOMATION_TIMEOUT_MS, owner = 'desktop-main') {
  if (!DESKTOP_WECHAT_ENABLED) {
    return Promise.reject(new Error(`当前系统暂不支持桌面微信自动化：${process.platform}`));
  }
  const releaseLock = acquireWechatDesktopAutomationLock(owner, args);
  return new Promise((resolve, reject) => {
    const helperPath = wechatDesktopAutomationHelperPath();
    const command = process.platform === 'win32' ? 'powershell.exe' : helperPath;
    const helperArgs = process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, ...args]
      : args;
    const startedAt = Date.now();
    appendServiceLog(
      serviceLogPath(),
      `[desktop-wechat-helper] start owner=${owner} command=${command} helper=${helperPath} timeoutMs=${timeoutMs} cwd=${workspaceDir()} logDir=${logsDir()} args=${JSON.stringify(args)}`,
    );
    const child = spawn(command, helperArgs, {
      cwd: workspaceDir(),
      env: {
        ...process.env,
        MAO_APP_ROOT: activeAppDir(),
        MAO_WORKSPACE_PATH: workspaceDir(),
        MAO_LOG_DIR: logsDir(),
        ...desktopWechatEnv(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    appendServiceLog(serviceLogPath(), `[desktop-wechat-helper] spawned owner=${owner} pid=${child.pid || 'unknown'}`);
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (callback) => {
      if (finished) return;
      finished = true;
      releaseLock();
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const durationMs = Date.now() - startedAt;
      appendServiceLog(serviceLogPath(), `[desktop-wechat-helper] timeout owner=${owner} pid=${child.pid || 'unknown'} durationMs=${durationMs} stdout=${JSON.stringify(helperLogPreview(stdout))} stderr=${JSON.stringify(helperLogPreview(stderr))}`);
      finish(() => reject(new Error(`桌面微信 helper 超时（${Math.round(timeoutMs / 1000)} 秒）。`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      appendServiceLog(serviceLogPath(), `[desktop-wechat-helper] spawn error owner=${owner} pid=${child.pid || 'unknown'} durationMs=${durationMs} error=${error.message}`);
      finish(() => reject(error));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      finish(() => {
        const durationMs = Date.now() - startedAt;
        appendServiceLog(serviceLogPath(), `[desktop-wechat-helper] exit owner=${owner} pid=${child.pid || 'unknown'} code=${code} signal=${signal || ''} durationMs=${durationMs} stdout=${JSON.stringify(helperLogPreview(stdout))} stderr=${JSON.stringify(helperLogPreview(stderr))}`);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error((stderr || stdout || `helper 退出 code=${code} signal=${signal}`).trim()));
      });
    });
  });
}

async function createWechatDesktopDraft(options = {}) {
  const status = desktopWechatAutomationStatus();
  if (!status.supported) throw new Error('当前系统暂不支持桌面微信自动化。');
  if (!status.implemented) throw new Error('当前系统的桌面微信自动化入口尚未实现。');
  if (!status.helperInstalled) throw new Error(status.helperError || '桌面微信自动化 helper 不存在，请重新打包或更新客户端。');
  if (!status.wechatInstalled) throw new Error('未找到桌面微信，请先安装并登录 WeChat。');
  if (status.permissionRequired && !status.accessibilityTrusted) throw new Error('桌面应用尚未获得辅助功能权限，请先点击“申请微信桌面权限”。');

  const roomName = normalizeAutomationText(options.roomName);
  const mentionNames = Array.isArray(options.mentionNames)
    ? options.mentionNames.map((name) => normalizeAutomationText(name)).filter(Boolean)
    : String(options.mentionNames || '').split(/[,，]/).map((name) => name.trim()).filter(Boolean);
  const text = normalizeAutomationText(options.text, '桌面微信自动化@测试，请忽略');
  if (!roomName) throw new Error('缺少微信群名。');

  const args = [
    `--room=${roomName}`,
    `--mentions=${mentionNames.join(',')}`,
    `--text=${text}`,
    options.send ? '--send' : '--dry-run',
    `--select-method=${options.selectMethod || 'click-first'}`,
  ];
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  for (const imagePath of imagePaths.map((item) => String(item || '').trim()).filter(Boolean)) {
    args.push(`--image=${imagePath}`);
  }
  const result = await runWechatDesktopAutomationHelper(args, 120_000, 'desktop-send');
  return {
    ok: true,
    roomName,
    mentionNames,
    send: Boolean(options.send),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function testWechatDesktopKeyboard(options = {}) {
  const status = desktopWechatAutomationStatus();
  if (!status.supported) throw new Error('当前系统暂不支持桌面微信自动化。');
  if (!status.implemented) throw new Error('当前系统的桌面微信自动化入口尚未实现。');
  if (!status.helperInstalled) throw new Error(status.helperError || '桌面微信自动化 helper 不存在，请重新打包或更新客户端。');
  if (!status.wechatInstalled) throw new Error('未找到桌面微信，请先安装并登录 WeChat。');
  if (status.permissionRequired && !status.accessibilityTrusted) throw new Error('桌面应用尚未获得辅助功能权限，请先点击“申请微信桌面权限”。');

  const roomName = normalizeAutomationText(options.roomName);
  const pressEnter = Boolean(options.pressEnter);
  const openRetry = Boolean(options.openRetry);
  const args = [openRetry ? '--open-retry-test' : (pressEnter ? '--keyboard-enter-test' : '--keyboard-test')];
  if (roomName) args.push(`--room=${roomName}`);
  const result = await runWechatDesktopAutomationHelper(args, openRetry ? 90_000 : 30_000, openRetry ? 'desktop-open-retry-test' : 'desktop-keyboard-test');
  let payload = null;
  try {
    payload = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
  } catch {}
  return {
    ok: true,
    roomName,
    text: payload?.text || '',
    action: payload?.action || (openRetry ? 'open-retry-test' : (pressEnter ? 'keyboard-enter-test' : 'keyboard-test')),
    selection: payload?.selection || '',
    pressEnter,
    openRetry,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
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

function serviceStartTimeoutMs() {
  const configured = Number(process.env.MAO_SERVICE_START_TIMEOUT_MS || 0);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SERVICE_START_TIMEOUT_MS;
}

function tailFile(filePath, maxBytes = 16_384) {
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8').trim();
  } catch {
    return '';
  }
}

function appendServiceLog(serviceLogPath, message) {
  try {
    fs.appendFileSync(serviceLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

function closeLogStream(logStream) {
  return new Promise((resolve) => {
    logStream.end(resolve);
    setTimeout(resolve, 500).unref();
  });
}

function startupError(message, serviceLogPath) {
  const logTail = tailFile(serviceLogPath);
  const detail = logTail ? `\n\n最近服务日志：\n${logTail}` : '\n\n最近服务日志：暂无内容。';
  return new Error(`${message}\n\n日志路径：${serviceLogPath}${detail}`);
}

function waitForHealth(port, timeout = serviceStartTimeoutMs()) {
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
      if (Date.now() - started >= timeout) reject(new Error(`本地服务启动超时（已等待 ${Math.round(timeout / 1000)} 秒）。`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function probeServiceHealth(port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error('service port is not ready'));
      return;
    }
    const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve(true);
      else reject(new Error(`health status ${response.statusCode}`));
    });
    request.once('error', reject);
    request.setTimeout(timeout, () => request.destroy(new Error(`health timeout ${timeout}ms`)));
  });
}

function startServiceWatchdog() {
  if (serviceWatchdogTimer) return;
  serviceWatchdogTimer = setInterval(async () => {
    if (quitting) return;
    try {
      if (!serverProcess) throw new Error('service process is not running');
      await probeServiceHealth(runtimePort);
      serviceHealthFailures = 0;
    } catch (error) {
      serviceHealthFailures += 1;
      appendServiceLog(serviceLogPath(), `[desktop-watchdog] health failed ${serviceHealthFailures}/${SERVICE_WATCHDOG_MAX_FAILURES}: ${error.message}`);
      if (serviceHealthFailures < SERVICE_WATCHDOG_MAX_FAILURES) return;
      serviceHealthFailures = 0;
      try {
        appendServiceLog(serviceLogPath(), '[desktop-watchdog] restarting local service');
        await startServer(false);
        if (mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.loadURL(`http://127.0.0.1:${runtimePort}`);
        }
        appendServiceLog(serviceLogPath(), '[desktop-watchdog] local service restarted');
      } catch (restartError) {
        appendServiceLog(serviceLogPath(), `[desktop-watchdog] restart failed ${restartError.message}`);
      }
    }
  }, SERVICE_WATCHDOG_INTERVAL_MS);
  serviceWatchdogTimer.unref?.();
}

function stopServiceWatchdog() {
  if (serviceWatchdogTimer) clearInterval(serviceWatchdogTimer);
  serviceWatchdogTimer = null;
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
  const logs = logsDir();
  fs.mkdirSync(logs, { recursive: true });
  const logPath = serviceLogPath();
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  appendServiceLog(logPath, `[desktop] starting service port=${runtimePort} appRoot=${appRoot} workspace=${workspaceDir()}`);
  const child = spawn(process.execPath, [entry], {
    cwd: workspaceDir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(runtimePort),
      MAO_APP_ROOT: appRoot,
      MAO_WORKSPACE_PATH: workspaceDir(),
      MAO_LOG_DIR: logs,
      WECHAT_BRIDGE_URL: `http://127.0.0.1:${runtimePort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.once('error', (error) => {
    appendServiceLog(logPath, `[desktop] service spawn error ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (serverProcess === child) serverProcess = null;
    if (!quitting) appendServiceLog(logPath, `[desktop] service exited code=${code} signal=${signal}`);
  });
  try {
    await Promise.race([
      waitForHealth(runtimePort),
      new Promise((_, reject) => {
        child.once('error', (error) => reject(error));
        child.once('exit', (code, signal) => reject(new Error(`本地服务提前退出 code=${code} signal=${signal}`)));
      }),
    ]);
    appendServiceLog(logPath, `[desktop] service healthy port=${runtimePort}`);
  } catch (error) {
    child.kill('SIGTERM');
    await closeLogStream(logStream);
    if (allowFallback && updater.currentAppDir() && updater.disableCurrent(error.message)) {
      return startServer(false);
    }
    throw startupError(error.message, logPath);
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
  startServiceWatchdog();
  setTimeout(() => ipcMain.emit('runtime:auto-check'), 5000);
}

ipcMain.handle('desktop:get-info', () => ({
  shellVersion: app.getVersion(),
  runtimeVersion: updater.currentVersion(),
  workspacePath: workspaceDir(),
  logsPath: logsDir(),
  updateConfigured: Boolean(feedUrl),
}));

ipcMain.handle('desktop:open-workspace', async () => {
  await shell.openPath(workspaceDir());
});

ipcMain.handle('desktop:open-logs', async () => {
  fs.mkdirSync(logsDir(), { recursive: true });
  await shell.openPath(logsDir());
});

ipcMain.handle('desktop:launch-chrome-service', (_event, service) => launchChromeService(service));
ipcMain.handle('desktop:wechat-automation-status', () => desktopWechatAutomationStatus());
ipcMain.handle('desktop:request-wechat-automation-permissions', () => requestDesktopWechatAutomationPermissions());
ipcMain.handle('desktop:create-wechat-draft', (_event, options) => createWechatDesktopDraft(options));
ipcMain.handle('desktop:test-wechat-keyboard', (_event, options) => testWechatDesktopKeyboard(options));

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
  stopServiceWatchdog();
  void stopServer();
});
