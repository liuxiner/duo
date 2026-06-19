import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const semverPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function value(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function parseVersion(input) {
  const match = semverPattern.exec(String(input || '').trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease || '',
    build: build || '',
  };
}

function versionString(version) {
  return [
    `${version.major}.${version.minor}.${version.patch}`,
    version.prerelease ? `-${version.prerelease}` : '',
    version.build ? `+${version.build}` : '',
  ].join('');
}

function normalizeVersion(input) {
  const parsed = parseVersion(input);
  if (!parsed) throw new Error(`无效版本号：${input || '(empty)'}，请使用 SemVer，例如 0.1.1。`);
  return versionString(parsed);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return left.prerelease.localeCompare(right.prerelease);
}

function bumpVersion(input, bump) {
  const version = parseVersion(input);
  if (!version) throw new Error(`无法递增无效版本号：${input}`);
  if (version.prerelease || version.build) {
    throw new Error('自动递增只支持稳定版本；预发布版本请直接输入完整 version。');
  }
  if (bump === 'major') return `${version.major + 1}.0.0`;
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  if (bump === 'patch') return `${version.major}.${version.minor}.${version.patch + 1}`;
  throw new Error(`无效 bump 类型：${bump}，只能是 patch / minor / major。`);
}

function latestTaggedVersion({ stableOnly = false } = {}) {
  let output = '';
  try {
    output = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' });
  } catch {
    return '';
  }
  for (const tag of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const parsed = parseVersion(tag);
    if (parsed && (!stableOnly || (!parsed.prerelease && !parsed.build))) return versionString(parsed);
  }
  return '';
}

function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { stdio: 'ignore' });
    return true;
  } catch {
    // Continue to remote check.
  }
  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'));
}

async function writeJson(file, data) {
  await writeFile(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const rootPkg = await readJson('package.json');
const desktopPkg = await readJson('desktop/package.json');
const explicitVersion = value('--version', '').trim();
const bump = value('--bump', 'patch').trim() || 'patch';
const dryRun = hasFlag('--dry-run');
const checkTag = hasFlag('--check-tag');
const currentVersion = normalizeVersion(rootPkg.version);
const taggedVersion = latestTaggedVersion({ stableOnly: !explicitVersion });
const baseVersion = taggedVersion && compareVersions(taggedVersion, currentVersion) > 0 ? taggedVersion : currentVersion;
const version = explicitVersion ? normalizeVersion(explicitVersion) : bumpVersion(baseVersion, bump);
const tag = `v${version}`;

if (checkTag && tagExists(tag)) {
  throw new Error(`Release tag 已存在：${tag}`);
}

if (!dryRun) {
  rootPkg.version = version;
  rootPkg.mao = rootPkg.mao || {};
  rootPkg.mao.minShellVersion = version;
  desktopPkg.version = version;
  await writeJson('package.json', rootPkg);
  await writeJson('desktop/package.json', desktopPkg);
}

const result = {
  version,
  tag,
  baseVersion,
  currentVersion,
  latestTaggedVersion: taggedVersion,
  bump: explicitVersion ? 'explicit' : bump,
  dryRun,
};

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, outputValue]) => `${key}=${outputValue}`).join('\n') + '\n');
}

console.log(JSON.stringify(result, null, 2));
