import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const sourceHtml = path.join(root, 'index.html');
const sourceData = path.join(root, 'kanban-data.json');
const sourceExampleConfig = path.join(root, 'kanban-config.example.json');

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function extractBlock(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) throw new Error(`Missing <${tag}> block in index.html`);
  return { full: match[0], body: `${match[1].trim()}\n` };
}

const html = await readFile(sourceHtml, 'utf8');
const style = extractBlock(html, 'style');
const script = extractBlock(html, 'script');
const cssFile = `assets/kanban.${hash(style.body)}.css`;
const jsFile = `assets/kanban.${hash(script.body)}.js`;
const builtHtml = html
  .replace(style.full, `<link rel="stylesheet" href="${cssFile}">`)
  .replace(script.full, `<script src="${jsFile}" defer></script>`);

const data = await readFile(sourceData, 'utf8');
const exampleConfig = await readFile(sourceExampleConfig, 'utf8');

await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, 'assets'), { recursive: true });

await writeFile(path.join(distDir, 'index.html'), builtHtml, 'utf8');
await writeFile(path.join(distDir, cssFile), style.body, 'utf8');
await writeFile(path.join(distDir, jsFile), script.body, 'utf8');
await writeFile(path.join(distDir, 'kanban-data.json'), data, 'utf8');
await writeFile(path.join(distDir, 'kanban-config.example.json'), exampleConfig, 'utf8');
await writeFile(path.join(distDir, '.nojekyll'), '', 'utf8');

console.log(`Built static Kanban: ${path.relative(root, distDir)}`);
