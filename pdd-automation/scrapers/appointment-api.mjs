import { PDD_PAGE_SIZE } from '../../scripts/pdd-page-tools.mjs';
import { loginAndSavePddStorageState } from '../auth/login.mjs';
import {
  appointmentRowsFromGoodsList,
  queryAppointmentGoodsList,
  writeJsonSnapshot,
} from '../clients/pdd-client.mjs';

function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatBeijingTimestamp(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}`;
}

export function formatBeijingDate(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function yesterdayBeijingDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  const beijing = new Date(utc + 8 * 60 * 60 * 1000);
  beijing.setDate(beijing.getDate() - 1);
  return formatBeijingDate(beijing);
}

export function appointmentApiRequestBody(cfg) {
  return cfg.apiRequestBody || {
    pageNumber: 1,
    pageSize: cfg.targetPageSize || PDD_PAGE_SIZE,
    ...(cfg.apiWarehouseIds?.length ? { warehouseIdList: cfg.apiWarehouseIds } : {}),
  };
}

export async function collectAppointmentViaApi(cfg, context, {
  calculateRows = (records) => records,
  calculatedHeaders = [],
} = {}) {
  await loginAndSavePddStorageState(cfg, context);

  const collectedAt = formatBeijingTimestamp(new Date());
  const salesDate = cfg.syncDate || (cfg.selectYesterday ? yesterdayBeijingDate() : formatBeijingDate(new Date()));
  const requestBody = appointmentApiRequestBody(cfg);
  console.log(`Calling PDD API queryAppointmentGoodsList for ${salesDate}.`);
  const body = await queryAppointmentGoodsList(context, { body: requestBody });
  await writeJsonSnapshot(cfg.apiSnapshotJson, {
    collectedAt,
    salesDate,
    endpoint: 'appointmentGoodsList',
    requestBody,
    response: body,
  });
  console.log(`Wrote PDD API response snapshot to ${cfg.apiSnapshotJson}.`);

  const normalized = appointmentRowsFromGoodsList(body, {
    collectedAt,
    salesDate,
  });
  const calculatedRows = calculateRows(normalized.records, collectedAt, salesDate);
  console.log(`PDD API returned ${normalized.records.length} warehouse rows from ${normalized.expectedTotal} goods records.`);
  console.log(`Calculated merged rows from API: ${calculatedRows.length}.`);
  return {
    collectedAt,
    salesDate,
    headers: calculatedHeaders,
    rows: calculatedRows,
    rawHeaders: normalized.rawHeaders,
    rawRows: normalized.rawRows,
    sourceUrl: normalized.sourceUrl,
    expectedTotal: normalized.expectedTotal,
  };
}
