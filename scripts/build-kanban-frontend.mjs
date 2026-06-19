import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourceFile = path.join(root, 'web', 'kanban.html');
const outputDir = path.join(root, 'dist', 'public');
const assetsDir = path.join(outputDir, 'assets');

function contentHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function extractBlock(html, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  if (!match) throw new Error(`Missing <${tag}> block in ${sourceFile}`);
  return {
    full: match[0],
    body: `${match[1].trim()}\n`,
  };
}

function htmlWithExternalAssets(html, style, script, cssFile, jsFile) {
  return html
    .replace(style.full, `<link rel="stylesheet" href="/assets/${cssFile}">`)
    .replace(script.full, `<script src="/assets/${jsFile}" defer></script>`);
}

const html = await readFile(sourceFile, 'utf8');
const style = extractBlock(html, 'style');
const script = extractBlock(html, 'script');
const cssFile = `kanban.${contentHash(style.body)}.css`;
const jsFile = `kanban.${contentHash(script.body)}.js`;
const builtHtml = htmlWithExternalAssets(html, style, script, cssFile, jsFile);

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });
await writeFile(path.join(outputDir, 'kanban.html'), builtHtml, 'utf8');
await writeFile(path.join(assetsDir, cssFile), style.body, 'utf8');
await writeFile(path.join(assetsDir, jsFile), script.body, 'utf8');
await writeFile(
  path.join(outputDir, 'manifest.json'),
  `${JSON.stringify({
    builtAt: new Date().toISOString(),
    source: path.relative(root, sourceFile),
    html: 'kanban.html',
    css: `assets/${cssFile}`,
    js: `assets/${jsFile}`,
  }, null, 2)}\n`,
  'utf8'
);

console.log(`Built kanban frontend: ${path.relative(root, outputDir)}`);
console.log(`- /assets/${cssFile}`);
console.log(`- /assets/${jsFile}`);
