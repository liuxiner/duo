import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const minShellVersion = process.env.MAO_MIN_SHELL_VERSION || pkg.mao?.minShellVersion;
const platform = `${process.platform}-${process.arch}`;
const appDir = path.join(root, 'dist', 'runtime');
const releaseDir = path.join(root, 'release');
const baseUrl = (process.env.MAO_UPDATE_BASE_URL || 'https://example.com/duoduo-updates').replace(/\/?$/, '/');

if (!minShellVersion) throw new Error('package.json 缺少 mao.minShellVersion。');

const excludedRuntimeEntries = new Set(['node_modules']);

async function collectFiles(dir, prefix = '', depth = 0) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (depth === 0 && excludedRuntimeEntries.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, relative, depth + 1));
    else if (entry.isFile()) {
      const bytes = await readFile(fullPath);
      files.push({
        path: relative,
        sourcePath: fullPath,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files;
}

function releaseNotes() {
  return process.env.MAO_RELEASE_NOTES || '';
}

await mkdir(releaseDir, { recursive: true });
const files = await collectFiles(appDir, 'app');
const manifest = {
  runtimeVersion: version,
  minShellVersion,
  platform,
  dependencies: {
    strategy: 'link-packaged-runtime-node-modules',
  },
  files: files.map(({ sourcePath, ...file }) => file),
  totalSize: files.reduce((sum, file) => sum + file.size, 0),
  releaseNotes: releaseNotes(),
  createdAt: new Date().toISOString(),
};
const zipName = `runtime-duoduo-${version}-${platform}.zip`;
const manifestName = `manifest-duoduo-${version}-${platform}.json`;
const zipPath = path.join(releaseDir, zipName);

await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const file of files) {
    archive.file(file.sourcePath, { name: file.path });
  }
  archive.finalize();
});

await writeFile(path.join(releaseDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
const zipSize = (await stat(zipPath)).size;
const latest = {
  version,
  tag: `v${version}`,
  releaseNotes: manifest.releaseNotes,
  platforms: {
    [platform]: {
      manifest: new URL(`v${version}/${manifestName}`, baseUrl).toString(),
      runtime: new URL(`v${version}/${zipName}`, baseUrl).toString(),
      size: zipSize,
    },
  },
};
await writeFile(path.join(releaseDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Runtime update built: ${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
