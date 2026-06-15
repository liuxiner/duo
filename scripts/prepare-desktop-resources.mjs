import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const runtimeDir = path.join(root, 'dist', 'runtime');
const desktopRuntimeDir = path.join(root, 'desktop', 'resources', 'runtime');
const entries = [
  '.env.example',
  'package.json',
  'web',
  'scripts',
];

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

await rm(runtimeDir, { recursive: true, force: true });
await rm(desktopRuntimeDir, { recursive: true, force: true });
await rm(path.join(root, 'desktop', 'resources', 'app'), { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const entry of entries) {
  await cp(path.join(root, entry), path.join(runtimeDir, entry), { recursive: true });
}
const deployDir = path.join(root, 'dist', '.runtime-deploy');
try {
  await rm(deployDir, { recursive: true, force: true });
  const result = runPnpm([
    '--config.inject-workspace-packages=true',
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
} finally {
  await rm(deployDir, { recursive: true, force: true });
}
await cp(runtimeDir, desktopRuntimeDir, { recursive: true, verbatimSymlinks: true });
console.log(`Runtime sidecar built: ${path.relative(root, runtimeDir)}`);
console.log(`Desktop runtime prepared: ${path.relative(root, desktopRuntimeDir)}`);
