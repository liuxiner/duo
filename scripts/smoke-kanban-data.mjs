import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function loadDotEnv(file = process.env.ENV_FILE || '.env') {
  let text;
  try {
    text = await readFile(path.resolve(root, file), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadDotEnv();

const { loadKanbanData } = await import('../web/kanban-data.mjs');
const payload = await loadKanbanData({ forceRefresh: true, forceWriteback: true });
const writeback = payload.writeback || {};

console.log(JSON.stringify({
  ok: payload.ok,
  refreshedAt: payload.refreshedAt,
  dateCount: payload.dates?.length || 0,
  firstDate: payload.dates?.[0] || '',
  lastDate: payload.dates?.at?.(-1) || '',
  rawRows: payload.source?.rawRowCount || 0,
  manualRows: payload.source?.manualInputRowCount || 0,
  rulesRows: payload.source?.rulesRowCount || 0,
  bigBoardFieldCount: payload.source?.bigBoardFieldCount || 0,
  smallBoardFieldCount: payload.source?.smallBoardFieldCount || 0,
  writeback: {
    skipped: Boolean(writeback.skipped),
    writtenCount: writeback.writtenCount || 0,
    error: writeback.error || '',
    writtenDates: (writeback.written || []).map((item) => item.date).slice(0, 8),
  },
  warnings: (payload.warnings || []).slice(0, 8),
}, null, 2));
