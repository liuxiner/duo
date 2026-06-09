import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
const input = value('--input', 'release');
const output = value('--output', 'release/latest.json');
const baseUrl = value('--base-url', process.env.MAO_UPDATE_BASE_URL || 'https://example.com/duoduo-updates').replace(/\/?$/, '/');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = value('--version', pkg.version);
const releaseNotes = value('--release-notes', process.env.MAO_RELEASE_NOTES || '');
const names = await readdir(input);
const manifests = names.filter((name) => name.startsWith('manifest-duoduo-') && name.endsWith('.json'));
const platforms = {};

for (const name of manifests) {
  const manifest = JSON.parse(await readFile(path.join(input, name), 'utf8'));
  const zipName = `runtime-duoduo-${manifest.runtimeVersion}-${manifest.platform}.zip`;
  const zipPath = path.join(input, zipName);
  platforms[manifest.platform] = {
    manifest: new URL(`v${version}/${name}`, baseUrl).toString(),
    runtime: new URL(`v${version}/${zipName}`, baseUrl).toString(),
    size: (await stat(zipPath)).size,
  };
}
if (!Object.keys(platforms).length) throw new Error(`未在 ${input} 找到运行时 manifest。`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ version, tag: `v${version}`, releaseNotes, platforms }, null, 2)}\n`);
console.log(`Update feed written: ${output}`);
