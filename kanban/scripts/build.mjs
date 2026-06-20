import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const sourceHtml = path.join(root, 'index.html');
const sourceExampleData = path.join(root, 'kanban-data.example.json');
const sourceExampleConfig = path.join(root, 'kanban-config.example.json');

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function extractBlock(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) throw new Error(`Missing <${tag}> block in index.html`);
  return { full: match[0], body: `${match[1].trim()}\n` };
}

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

async function gzipTar(files, outputPath) {
  const { gzipSync } = await import('node:zlib');
  const chunks = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    chunks.push(tarHeader(file.name, content.length));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  await writeFile(outputPath, gzipSync(Buffer.concat(chunks)));
}

const html = await readFile(sourceHtml, 'utf8');
const style = extractBlock(html, 'style');
const script = extractBlock(html, 'script');
const cssFile = `assets/kanban.${hash(style.body)}.css`;
const jsFile = `assets/kanban.${hash(script.body)}.js`;
const builtHtml = html
  .replace(style.full, `<link rel="stylesheet" href="${cssFile}">`)
  .replace(script.full, `<script src="${jsFile}" defer></script>`);

const exampleData = await readFile(sourceExampleData, 'utf8');
const exampleConfig = await readFile(sourceExampleConfig, 'utf8');

await rm(distDir, { recursive: true, force: true });
await rm(releaseDir, { recursive: true, force: true });
await mkdir(path.join(distDir, 'assets'), { recursive: true });
await mkdir(releaseDir, { recursive: true });

await writeFile(path.join(distDir, 'index.html'), builtHtml, 'utf8');
await writeFile(path.join(distDir, cssFile), style.body, 'utf8');
await writeFile(path.join(distDir, jsFile), script.body, 'utf8');
await writeFile(path.join(distDir, 'kanban-data.json'), exampleData, 'utf8');
await writeFile(path.join(distDir, 'kanban-config.example.json'), exampleConfig, 'utf8');
await writeFile(path.join(distDir, '.nojekyll'), '', 'utf8');

const releaseName = `mao-kanban-static-${new Date().toISOString().slice(0, 10)}.tar.gz`;
await gzipTar([
  { name: 'index.html', content: builtHtml },
  { name: cssFile, content: style.body },
  { name: jsFile, content: script.body },
  { name: 'kanban-data.json', content: exampleData },
  { name: 'kanban-config.example.json', content: exampleConfig },
  { name: '.nojekyll', content: '' },
], path.join(releaseDir, releaseName));

console.log(`Built static Kanban: ${path.relative(root, distDir)}`);
console.log(`Release artifact: ${path.relative(root, path.join(releaseDir, releaseName))}`);
