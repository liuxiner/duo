const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extractZip = require('extract-zip');

function compareVersion(left, right) {
  const a = String(left).replace(/^v/, '').split('.').map(Number);
  const b = String(right).replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createRuntimeUpdater({ app, feedUrl, bundledVersion }) {
  const runtimeRoot = () => path.join(app.getPath('userData'), 'runtime');
  const currentFile = () => path.join(runtimeRoot(), 'current.json');
  const versionsDir = () => path.join(runtimeRoot(), 'versions');
  const packagedDependencies = () => app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'node_modules')
    : path.resolve(__dirname, '..', '..', 'node_modules');

  function readCurrent() {
    try {
      const current = JSON.parse(fs.readFileSync(currentFile(), 'utf8'));
      const dir = path.join(versionsDir(), current.version);
      if (fs.existsSync(path.join(dir, 'manifest.json'))) return { ...current, dir };
    } catch {}
    return null;
  }

  function currentVersion() {
    return readCurrent()?.version || bundledVersion;
  }

  function currentAppDir() {
    const current = readCurrent();
    return current ? path.join(current.dir, 'app') : null;
  }

  function disableCurrent(reason) {
    const current = readCurrent();
    if (!current) return false;
    fs.mkdirSync(runtimeRoot(), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot(), 'failed-runtime.json'), JSON.stringify({
      version: current.version,
      failedAt: new Date().toISOString(),
      reason,
    }, null, 2));
    fs.rmSync(currentFile(), { force: true });
    return true;
  }

  function resolveUrl(raw, base) {
    return raw ? new URL(raw, base).toString() : '';
  }

  async function check() {
    if (!feedUrl) throw new Error('尚未配置热更新地址 MAO_UPDATE_FEED_URL。');
    const response = await fetch(feedUrl, { headers: { 'User-Agent': 'DuoduoDigitalManager' } });
    if (!response.ok) throw new Error(`更新服务器返回 ${response.status}`);
    const feed = await response.json();
    const platform = `${process.platform}-${process.arch}`;
    const entry = feed.platforms?.[platform];
    const latestVersion = String(feed.version || feed.tag || '').replace(/^v/, '');
    if (!entry) return { available: false, currentVersion: currentVersion(), latestVersion, message: '当前平台暂无更新包。' };
    return {
      available: compareVersion(latestVersion, currentVersion()) > 0,
      currentVersion: currentVersion(),
      latestVersion,
      releaseNotes: feed.releaseNotes || '',
      manifestUrl: resolveUrl(entry.manifest, feedUrl),
      runtimeUrl: resolveUrl(entry.runtime, feedUrl),
      size: entry.size || 0,
    };
  }

  function verifyManifest(dir, manifest) {
    const root = path.resolve(dir);
    for (const entry of manifest.files || []) {
      const file = path.resolve(dir, entry.path);
      if (!isInside(file, root) || !fs.statSync(file).isFile()) throw new Error(`更新包文件无效：${entry.path}`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (hash !== entry.sha256) throw new Error(`更新包校验失败：${entry.path}`);
    }
  }

  async function download(result, onProgress) {
    const staging = path.join(runtimeRoot(), 'staging', result.latestVersion);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const zipPath = path.join(staging, 'runtime.zip');
    const response = await fetch(result.runtimeUrl, { headers: { 'User-Agent': 'DuoduoDigitalManager' } });
    if (!response.ok || !response.body) throw new Error(`更新包下载失败：${response.status}`);
    const total = Number(response.headers.get('content-length') || result.size || 0);
    let received = 0;
    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      received += chunk.length;
      onProgress(received, total);
    });
    await pipeline(stream, createWriteStream(zipPath));
    const extracted = path.join(staging, 'extracted');
    await extractZip(zipPath, { dir: extracted });
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
    if (manifest.runtimeVersion !== result.latestVersion) throw new Error('更新包版本与更新源不一致。');
    if (manifest.platform !== `${process.platform}-${process.arch}`) throw new Error('更新包平台不匹配。');
    if (compareVersion(app.getVersion(), manifest.minShellVersion) < 0) throw new Error(`需要先安装桌面壳 ${manifest.minShellVersion} 或更高版本。`);
    verifyManifest(extracted, manifest);
    const target = path.join(versionsDir(), result.latestVersion);
    fs.mkdirSync(versionsDir(), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(extracted, target);
    const dependencyLink = path.join(target, 'app', 'node_modules');
    if (fs.existsSync(packagedDependencies())) {
      fs.rmSync(dependencyLink, { recursive: true, force: true });
      fs.symlinkSync(
        packagedDependencies(),
        dependencyLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    fs.writeFileSync(currentFile(), JSON.stringify({ version: result.latestVersion }, null, 2));
    fs.rmSync(path.join(runtimeRoot(), 'staging'), { recursive: true, force: true });
    return result.latestVersion;
  }

  return { check, download, currentVersion, currentAppDir, disableCurrent };
}

module.exports = { createRuntimeUpdater };
