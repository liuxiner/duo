import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const target = path.join(root, 'desktop', 'resources', 'app');
const entries = [
  '.env.example',
  'package.json',
  'web',
  'scripts',
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of entries) {
  await cp(path.join(root, entry), path.join(target, entry), { recursive: true });
}
console.log(`Desktop resources prepared: ${path.relative(root, target)}`);
