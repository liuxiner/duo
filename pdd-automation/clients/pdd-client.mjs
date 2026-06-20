import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PDD_ORIGIN = 'https://mc.pinduoduo.com';
export const PDD_ORDER_MANAGEMENT_URL = `${PDD_ORIGIN}/ddmc-mms/order/management`;

export const PDD_ENDPOINTS = {
  appointmentGoodsList: '/cartman-mms/appointment/queryAppointmentGoodsList',
  appointTime: '/cartman-mms/appointment/queryAppointTime',
  createDeliveryAppointment: '/cartman-mms/appointment/newCreateDeliveryAppointment',
  driverList: '/cartman-mms/appointment/queryDriverList',
  goodsWarehouseDetail: '/cartman-mms/appointment/queryGoodsWarehouseDetail',
  reservationWarehouseList: '/syndra-mms/supplier/warehouse/queryWarehouseListForReservation',
  warehouseGroupListWithExpress: '/tms-app/api/mms/hugo/v0/MmsSupplierAreaService/queryAreaWarehouseGroupListWithExpress',
  schedulePageQuery: '/orianna-mms/goods/schedule/pageQuery',
  supplierInboundPunishment: '/tms-app/api/supplier/neymar/v0/PunishmentAppealMmsService/querySupplierInboundPunishment',
  areaList: '/hugo-mms/area/queryAreaList',
};

export function resolvePddEndpoint(endpoint) {
  const value = PDD_ENDPOINTS[endpoint] || endpoint;
  if (!value) throw new Error('PDD API endpoint is required.');
  return String(value).startsWith('http') ? String(value) : new URL(value, PDD_ORIGIN).toString();
}

export function readJsonEnv(name, fallback = {}) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

export function pddStorageStatePath(root = process.cwd()) {
  return path.resolve(root, process.env.PDD_STORAGE_STATE || 'data/pdd-storage-state.json');
}

export async function savePddStorageState(context, storageStatePath = pddStorageStatePath()) {
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  return storageStatePath;
}

export function pddApiHeaders(extraHeaders = {}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json;charset=UTF-8',
    origin: PDD_ORIGIN,
    referer: PDD_ORDER_MANAGEMENT_URL,
    ...readJsonEnv('PDD_API_EXTRA_HEADERS_JSON', {}),
    ...extraHeaders,
  };
  if (process.env.PDD_ANTI_CONTENT) headers['anti-content'] = process.env.PDD_ANTI_CONTENT;
  return headers;
}

export async function pddJsonRequest(context, endpoint, {
  method = 'POST',
  data = {},
  headers = {},
  timeout = 30_000,
} = {}) {
  const url = resolvePddEndpoint(endpoint);
  const normalizedMethod = String(method || 'POST').toLowerCase();
  const options = { headers: pddApiHeaders(headers), timeout };
  if (!['get', 'head'].includes(normalizedMethod)) options.data = data || {};
  const requestMethod = context.request[normalizedMethod];
  if (typeof requestMethod !== 'function') throw new Error(`Unsupported PDD API method: ${method}`);
  const response = await requestMethod.call(context.request, url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text };
  }
  if (!response.ok()) {
    const error = new Error(`PDD API ${normalizedMethod.toUpperCase()} ${url} failed: HTTP ${response.status()}`);
    error.status = response.status();
    error.body = body;
    throw error;
  }
  if (body && body.success === false) {
    const error = new Error(`PDD API ${url} failed: ${body.errorMsg || body.message || body.errorCode || 'unknown error'}`);
    error.body = body;
    throw error;
  }
  return body;
}

export function appointmentGoodsListBody({ page = 1, pageSize = 100, warehouseIds = [], extra = {} } = {}) {
  return {
    pageNumber: page,
    pageSize,
    ...(warehouseIds.length ? { warehouseIdList: warehouseIds } : {}),
    ...extra,
  };
}

export function appointmentRowsFromGoodsList(body, {
  collectedAt = '',
  salesDate = '',
  sourceUrl = resolvePddEndpoint('appointmentGoodsList'),
} = {}) {
  const result = body?.result || body?.data || body || {};
  const goodsList = result.goodsAppointmentResultList || result.goodsList || result.list || [];
  const rawHeaders = [
    '采集时间',
    '销售日期',
    '商品名称',
    '商品ID',
    '供应商商品ID',
    '仓库ID',
    '仓库信息',
    '仓库类型',
    '实际入库量',
    '仓库总库存',
    '仓库预估总销售数',
    '预计缺货量',
    '预约在途量',
    '多拣量',
    '销售数(份)',
    '今日已预约',
    '今日预约次数',
    '是否可预约',
  ];
  const records = [];

  for (const goods of goodsList) {
    const salesByWarehouse = new Map();
    for (const sale of goods.warehouseSales || []) {
      const quantity = (sale.productSpecSellInfoList || []).reduce((sum, spec) => {
        const next = Number(spec.todayTotal ?? spec.goodsTotal ?? spec.replenishTotal ?? 0);
        return Number.isFinite(next) ? sum + next : sum;
      }, 0);
      salesByWarehouse.set(String(sale.warehouseId), quantity);
    }

    for (const warehouse of goods.warehouseInboundVOList || goods.warehouseQuantityVOS || []) {
      const warehouseId = warehouse.warehouseId;
      const warehouseName = warehouse.warehouseName || warehouse.name || '';
      const actualInbound = warehouse.actualInboundContainsAllotOnWay ?? warehouse.actualInbound ?? warehouse.centerWarehouseInventory ?? warehouse.shareWarehouseInventory;
      const salePlanNum = warehouse.salePlanNum ?? warehouse.planSales;
      const shortQuantity = warehouse.planShortGoodsQuantity ?? warehouse.shortGoodsQuantity;
      const salesQuantity = salesByWarehouse.get(String(warehouseId)) ?? 0;
      records.push({
        product: {
          name: goods.goodsName || goods.goodsVO?.goodsName || '',
          id: String(goods.goodsId || goods.goodsVO?.goodsId || ''),
        },
        采集时间: collectedAt,
        销售日期: salesDate,
        商品名称: goods.goodsName || goods.goodsVO?.goodsName || '',
        商品ID: String(goods.goodsId || goods.goodsVO?.goodsId || ''),
        供应商商品ID: String(goods.supplierProductId || ''),
        仓库ID: String(warehouseId || ''),
        仓库信息: warehouseName,
        仓库类型: warehouse.warehouseType ?? '',
        实际入库量: formatApiQuantity(actualInbound),
        仓库总库存: formatApiQuantity(actualInbound),
        仓库预估总销售数: formatApiQuantity(salePlanNum),
        预计缺货量: formatApiQuantity(shortQuantity),
        预约在途量: formatApiQuantity(warehouse.appointmentOnWayQuantity),
        多拣量: formatApiQuantity(warehouse.pickMoreGoodsQuantity),
        '销售数(份)': formatApiQuantity(salesQuantity),
        今日已预约: goods.todayAppointment ? '是' : '否',
        今日预约次数: goods.todayAppointmentCount ?? '',
        是否可预约: goods.active ? '是' : '否',
      });
    }
  }

  return {
    records,
    rawHeaders,
    rawRows: records.map((record) => rawHeaders.map((header) => record[header] ?? '')),
    expectedTotal: Number(result.total) || goodsList.length || records.length,
    sourceUrl,
    collectedAt,
    salesDate,
  };
}

function formatApiQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${Number.isInteger(number) ? number : Number(number.toFixed(2))}份`;
}

export async function queryAppointmentGoodsList(context, options = {}) {
  const body = options.body || appointmentGoodsListBody(options);
  return pddJsonRequest(context, 'appointmentGoodsList', { data: body, headers: options.headers });
}

export async function queryAppointTime(context, body, options = {}) {
  return pddJsonRequest(context, 'appointTime', { data: body, headers: options.headers });
}

export async function queryDriverList(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'driverList', { data: body, headers: options.headers });
}

export async function queryGoodsWarehouseDetail(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'goodsWarehouseDetail', { data: body, headers: options.headers });
}

export async function queryReservationWarehouseList(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'reservationWarehouseList', { data: body, headers: options.headers });
}

export async function queryWarehouseGroupListWithExpress(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'warehouseGroupListWithExpress', { data: body, headers: options.headers });
}

export async function querySchedulePage(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'schedulePageQuery', { data: body, headers: options.headers });
}

export async function querySupplierInboundPunishment(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'supplierInboundPunishment', { data: body, headers: options.headers });
}

export async function queryAreaList(context, body = {}, options = {}) {
  return pddJsonRequest(context, 'areaList', { data: body, headers: options.headers });
}

export async function createDeliveryAppointment(context, body, options = {}) {
  return pddJsonRequest(context, 'createDeliveryAppointment', { data: body, headers: options.headers });
}

export async function writeJsonSnapshot(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}
