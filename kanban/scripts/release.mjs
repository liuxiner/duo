import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(root, '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const staticOnly = process.argv.includes('--static');

function tarHeader(name, size, mode = 0o644) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

async function gzipTar(files, outputPath) {
  const { gzipSync } = await import('node:zlib');
  const chunks = [];
  for (const file of files) {
    const content = await readFile(file.path);
    chunks.push(tarHeader(file.name, content.length));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  await writeFile(outputPath, gzipSync(Buffer.concat(chunks)));
}

await access(path.join(distDir, 'index.html'));
await mkdir(releaseDir, { recursive: true });

const date = new Date().toISOString().slice(0, 10);
const distFiles = (await listFiles(distDir)).map((name) => ({
  name: staticOnly ? name : `dist/${name}`,
  path: path.join(distDir, name),
}));
const serviceFiles = staticOnly ? [] : [
  { name: 'server.mjs', path: path.join(root, 'server.mjs') },
  { name: 'package.json', path: path.join(root, 'package.json') },
  { name: '.env.example', path: path.join(root, '.env.example') },
  { name: 'README.md', path: path.join(root, 'README.md') },
  { name: 'server/kanban-data.mjs', path: path.join(repoRoot, 'web', 'kanban-data.mjs') },
];
const releaseName = staticOnly
  ? `mao-kanban-static-${date}.tar.gz`
  : `mao-kanban-service-${date}.tar.gz`;
const files = [...distFiles, ...serviceFiles];
await gzipTar(files, path.join(releaseDir, releaseName));

console.log(`Release artifact: ${path.relative(root, path.join(releaseDir, releaseName))}`);
