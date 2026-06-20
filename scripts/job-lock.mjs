import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

function defaultRoot() {
  return path.resolve(process.env.MAO_WORKSPACE_PATH || process.cwd());
}

function defaultLogDir(root = defaultRoot()) {
  return path.resolve(process.env.MAO_LOG_DIR || path.join(root, 'logs'));
}

export function jobLockPath({ root = defaultRoot(), logDir = defaultLogDir(root) } = {}) {
  return path.join(logDir, 'pdd-long-task.lock');
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function describeLock(lock) {
  const startedAt = lock?.startedAt ? `，开始于 ${lock.startedAt}` : '';
  const pid = lock?.pid ? `，pid=${lock.pid}` : '';
  return `${lock?.owner || '未知任务'}${pid}${startedAt}`;
}

export async function readJobLockStatus(options = {}) {
  const staleMs = Number(options.staleMs || DEFAULT_STALE_MS);
  const lockPath = jobLockPath(options);
  let lock = null;
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }

  const startedAtMs = Date.parse(lock.startedAt || '');
  const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : staleMs + 1;
  const alive = isPidAlive(lock.pid);
  if (!alive || ageMs > staleMs) {
    await unlink(lockPath).catch(() => {});
    return null;
  }
  return { ...lock, lockPath, ageMs, alive, description: describeLock(lock) };
}

export async function acquireJobLock({ owner, args = [], root = defaultRoot(), logDir = defaultLogDir(root), staleMs = DEFAULT_STALE_MS } = {}) {
  const lockPath = jobLockPath({ root, logDir });
  const existing = await readJobLockStatus({ root, logDir, staleMs });
  if (existing) {
    throw new Error(`已有长时任务正在运行：${existing.description}。请等待当前任务结束后再试。`);
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const lock = {
    pid: process.pid,
    owner: String(owner || 'unknown'),
    args: args.map((arg) => String(arg || '').slice(0, 120)),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  try {
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const racedLock = await readJobLockStatus({ root, logDir, staleMs });
      throw new Error(`已有长时任务正在运行：${racedLock?.description || '未知任务'}。请等待当前任务结束后再试。`);
    }
    throw error;
  }

  return async () => {
    let current = null;
    try {
      current = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (current?.pid === lock.pid && current?.startedAt === lock.startedAt) {
      await unlink(lockPath).catch(() => {});
    }
  };
}

export async function withJobLock(owner, fn, options = {}) {
  const release = await acquireJobLock({ ...options, owner, args: options.args || process.argv.slice(2) });
  try {
    return await fn();
  } finally {
    await release();
  }
}
