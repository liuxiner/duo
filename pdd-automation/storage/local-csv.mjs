import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function valuesToCsv(values) {
  return values.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function rowsToCsv(headers, rows) {
  return valuesToCsv([headers, ...rows]);
}

function safeCsvKey(value, fallback = 'unknown') {
  const key = String(value || '').trim().replace(/[^0-9A-Za-z_-]+/g, '-').replace(/^-+|-+$/g, '');
  return key || fallback;
}

export async function writeCsvFile(file, csv) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, csv, 'utf8');
  return file;
}

export async function writeFeishuMirrorCsv({
  dir,
  latestCsv,
  source = 'appointment',
  dateKey,
  stamp,
  values,
}) {
  const safeSource = safeCsvKey(source, 'appointment');
  const safeDate = safeCsvKey(dateKey, 'unknown-date');
  const safeStamp = safeCsvKey(stamp, 'latest');
  const fallbackDir = path.resolve(dir);
  const csv = `${valuesToCsv(values)}\n`;
  const dailyCsv = path.join(fallbackDir, `${safeSource}-feishu-${safeDate}.csv`);
  const snapshotCsv = path.join(fallbackDir, `${safeSource}-feishu-${safeDate}-${safeStamp}.csv`);
  const resolvedLatestCsv = latestCsv ? path.resolve(latestCsv) : path.join(fallbackDir, `${safeSource}-feishu-latest.csv`);

  await mkdir(fallbackDir, { recursive: true });
  await writeFile(dailyCsv, csv, 'utf8');
  await writeFile(snapshotCsv, csv, 'utf8');
  await writeFile(resolvedLatestCsv, csv, 'utf8');

  return {
    dailyCsv,
    snapshotCsv,
    latestCsv: resolvedLatestCsv,
  };
}
