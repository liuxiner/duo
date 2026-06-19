import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const runtimeDir = path.join(root, 'dist', 'runtime');
const desktopRuntimeDir = path.join(root, 'desktop', 'resources', 'runtime');
const swiftModuleCacheDir = path.join(root, 'dist', '.swift-module-cache');
const entries = [
  '.env.example',
  'package.json',
  'web',
  'scripts',
  'pdd-automation',
];
const webWechatRuntimePackages = ['file-box', 'qrcode', 'wechaty', 'wechaty-puppet-wechat'];

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath || '';
  if (npmExecPath && !/\.(?:cmd|bat)$/i.test(npmExecPath)) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  return spawnSync('pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

async function removeBinDirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name === '.bin') {
      await rm(fullPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await removeBinDirs(fullPath);
  }
}

function compileMacHelpers() {
  if (process.platform !== 'darwin') return;
  const source = path.join(root, 'desktop', 'native', 'macos', 'wechat-automation.swift');
  const outputDir = path.join(runtimeDir, 'bin');
  const output = path.join(outputDir, 'mao-wechat-automation');
  const result = spawnSync('xcrun', ['swiftc', '-module-cache-path', swiftModuleCacheDir, source, '-o', output], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`swiftc failed with exit code ${result.status}`);
}

async function copyWindowsHelpers() {
  const source = path.join(root, 'desktop', 'native', 'windows', 'wechat-automation.ps1');
  const output = path.join(runtimeDir, 'bin', 'mao-wechat-automation.ps1');
  const sourceBytes = await readFile(source);
  const firstNonAscii = sourceBytes.findIndex((byte) => byte > 0x7F);
  if (firstNonAscii >= 0) {
    throw new Error(`Windows WeChat helper must stay ASCII-only; found non-ASCII byte at offset ${firstNonAscii}. Use \\uXXXX/[char] escapes.`);
  }
  const utf8Bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const outputBytes = sourceBytes.subarray(0, 3).equals(utf8Bom)
    ? sourceBytes
    : Buffer.concat([utf8Bom, sourceBytes]);
  await writeFile(output, outputBytes);
  const writtenBytes = await readFile(output);
  if (!writtenBytes.subarray(0, 3).equals(utf8Bom)) {
    throw new Error('Windows WeChat helper must be written with a UTF-8 BOM.');
  }
}

async function removeOptionalPath(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

async function pruneWebWechatRuntime() {
  await removeOptionalPath(path.join(runtimeDir, 'scripts', 'wechaty-bot.mjs'));
  const packagePath = path.join(runtimeDir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    for (const packageName of webWechatRuntimePackages) {
      delete pkg.dependencies?.[packageName];
      delete pkg.devDependencies?.[packageName];
      await removeOptionalPath(path.join(runtimeDir, 'node_modules', packageName));
    }
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await rm(runtimeDir, { recursive: true, force: true });
await rm(desktopRuntimeDir, { recursive: true, force: true });
await rm(path.join(root, 'desktop', 'resources', 'app'), { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
await mkdir(path.join(runtimeDir, 'bin'), { recursive: true });
await mkdir(swiftModuleCacheDir, { recursive: true });
for (const entry of entries) {
  await cp(path.join(root, entry), path.join(runtimeDir, entry), { recursive: true });
}
compileMacHelpers();
await copyWindowsHelpers();
await pruneWebWechatRuntime();
const deployDir = path.join(root, 'dist', '.runtime-deploy');
try {
  await rm(deployDir, { recursive: true, force: true });
  const result = runPnpm([
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter',
    '.',
    'deploy',
    '--prod',
    deployDir,
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm deploy failed with exit code ${result.status}`);
  await cp(path.join(deployDir, 'node_modules'), path.join(runtimeDir, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await removeBinDirs(path.join(runtimeDir, 'node_modules'));
  await pruneWebWechatRuntime();
} finally {
  await rm(deployDir, { recursive: true, force: true });
}
await cp(runtimeDir, desktopRuntimeDir, { recursive: true, verbatimSymlinks: true });
console.log(`Runtime sidecar built: ${path.relative(root, runtimeDir)}`);
console.log(`Desktop runtime prepared: ${path.relative(root, desktopRuntimeDir)}`);
