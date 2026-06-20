import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePddBrowserContext, createPddBrowserContext, loginAndSavePddStorageState } from '../pdd-automation/auth/login.mjs';
import {
  pddStorageStatePath,
  queryAppointmentGoodsList,
  queryWarehouseGroupListWithExpress,
} from '../pdd-automation/clients/pdd-client.mjs';

const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || process.cwd());
const APPOINTMENT_DELIVERY_URL = 'https://mc.pinduoduo.com/ddmc-mms/appointment-delivery';
const DEFAULT_AREA_IDS = { 浙江省: 31 };
const DEFAULT_RESERVATION_ITEMS = [
  {
    id: '1',
    region: '浙江省',
    warehouseGroup: '杭州仓组',
    centerWarehouses: ['杭州中心1仓', '杭州中心2仓'],
    driverMobile: '',
    quantity: 100,
    preferredHour: '10:00',
    enabled: false,
  },
  {
    id: '2',
    region: '浙江省',
    warehouseGroup: '宁波仓组',
    centerWarehouses: ['宁波1仓'],
    driverMobile: '',
    quantity: 100,
    preferredHour: '14:00',
    enabled: false,
  },
  {
    id: '3',
    region: '浙江省',
    warehouseGroup: '温州仓组',
    centerWarehouses: ['温州1仓'],
    driverMobile: '',
    quantity: 100,
    preferredHour: '10:00',
    enabled: false,
  },
];

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function loadDotEnv(file = '.env') {
  let text = '';
  try { text = await readFile(path.resolve(ROOT, file), 'utf8'); } catch { return; }
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

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^浙江仓组\d+-/, '');
}

function splitList(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(/[,，、\s]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTime(value, fallback = '10:00') {
  const match = String(value || '').trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function enabledFromValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (/^(true|1|yes|y|on|启|启用)$/i.test(text)) return true;
  if (/^(false|0|no|n|off|停|停用)$/i.test(text)) return false;
  return fallback;
}

async function readReportConfig() {
  const configPath = path.resolve(ROOT, process.env.PDD_REPORT_CONFIG_PATH || 'data/report-config.json');
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeRule(item = {}, index = 0) {
  const quantity = Number(item.quantity ?? item['预约数量'] ?? 100);
  return {
    id: String(item.id || item.index || item['序号'] || index + 1),
    region: String(item.region || item['销售区域'] || '浙江省').trim(),
    warehouseGroup: String(item.warehouseGroup || item.warehouse || item['仓组'] || '').trim(),
    centerWarehouses: splitList(item.centerWarehouses || item.centerWarehouse || item['中心仓']),
    driverMobile: String(item.driverMobile || item['司机号码'] || '').trim(),
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 100,
    preferredHour: normalizeTime(item.preferredHour || item['预约时间'], '10:00'),
    enabled: enabledFromValue(item.enabled ?? item['状态'], false),
  };
}

function selectRules(config) {
  const ids = splitList(argValue('--ids', ''));
  const includeDisabled = hasArg('--include-disabled') || hasArg('--all');
  const rawItems = Array.isArray(config.reservation?.items) && config.reservation.items.length
    ? config.reservation.items
    : DEFAULT_RESERVATION_ITEMS;
  return rawItems
    .map(normalizeRule)
    .filter((rule) => (!ids.length || ids.includes(rule.id)) && (includeDisabled || rule.enabled));
}

function areaIdFor(region) {
  const envMap = process.env.PDD_RESERVATION_AREA_ID_MAP_JSON ? JSON.parse(process.env.PDD_RESERVATION_AREA_ID_MAP_JSON) : {};
  const areaId = envMap[region] || DEFAULT_AREA_IDS[region];
  if (!areaId) throw new Error(`暂未找到销售区域 ${region} 的 areaId，请配置 PDD_RESERVATION_AREA_ID_MAP_JSON。`);
  return Number(areaId);
}

async function resolveWarehouseGroup(context, rule) {
  const areaId = areaIdFor(rule.region);
  const body = await queryWarehouseGroupListWithExpress(context, { areaId2: areaId });
  const groups = body?.result?.warehouseGroupVOList || [];
  const target = normalizeText(rule.warehouseGroup);
  const group = groups.find((item) => normalizeText(item.warehouseGroupName).includes(target) || target.includes(normalizeText(item.warehouseGroupName)));
  if (!group) throw new Error(`找不到仓组：${rule.region} / ${rule.warehouseGroup}`);
  const centerTargets = rule.centerWarehouses.map(normalizeText);
  const warehouses = (group.warehouseList || []).filter((warehouse) => {
    const name = normalizeText(warehouse.warehouseName);
    return centerTargets.length ? centerTargets.some((targetName) => name === targetName || name.includes(targetName) || targetName.includes(name)) : !/物流/.test(name);
  });
  if (!warehouses.length) {
    throw new Error(`仓组 ${group.warehouseGroupName} 下找不到中心仓：${rule.centerWarehouses.join(', ') || '(未配置)'}`);
  }
  return { areaId, group, warehouses };
}

async function appointmentGoodsForRule(context, rule, meta) {
  const body = await queryAppointmentGoodsList(context, {
    page: 1,
    pageSize: 200,
    body: {
      page: 1,
      pageSize: 200,
      sessionDate: beijingDateKey(),
      areaId: meta.areaId,
      warehouseGroupId: meta.group.warehouseGroupId,
    },
  });
  const goodsList = body?.result?.goodsAppointmentResultList || [];
  const warehouseIds = new Set(meta.warehouses.map((warehouse) => Number(warehouse.warehouseId)));
  const goodsIds = [];
  for (const goods of goodsList) {
    const validIds = (goods.validWarehouseIdList || []).map(Number);
    const rows = goods.warehouseInboundVOList || [];
    const matches = rows.some((row) => warehouseIds.has(Number(row.warehouseId))) || validIds.some((id) => warehouseIds.has(id));
    if (matches && goods.goodsId) goodsIds.push(String(goods.goodsId));
  }
  return [...new Set(goodsIds)];
}

function beijingDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function clickSelectByLabel(page, labelText, optionText) {
  for (const offset of [110, 160, 220, 280]) {
    const label = page.getByText(labelText, { exact: true }).first();
    const box = await label.boundingBox().catch(() => null);
    if (!box) continue;
    await page.mouse.click(box.x + box.width + offset, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const option = page.getByText(optionText, { exact: false }).last();
    if (await option.count().catch(() => 0)) {
      await option.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      return true;
    }
  }
  return false;
}

async function applyFilters(page, rule, meta) {
  await clickSelectByLabel(page, '销售区域', rule.region).catch(() => false);
  await clickSelectByLabel(page, '仓组', meta.group.warehouseGroupName).catch(() => false);
  const query = page.getByRole('button', { name: /^查询$/ }).first();
  if (await query.count().catch(() => 0)) await query.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function selectVisibleAppointmentRows(page) {
  const actionBoxes = await page.getByText('去预约', { exact: true }).evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })).catch(() => []);
  if (!actionBoxes.length) return 0;

  const checkboxBoxes = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"], .BTN_checkbox_5-157-0, .CBX_checkbox_5-157-0, .checkbox'));
    return nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        index,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0,
        checked: Boolean(node.checked || node.getAttribute('aria-checked') === 'true'),
      };
    }).filter((item) => item.visible);
  });

  let selected = 0;
  for (const actionBox of actionBoxes) {
    const y = actionBox.y + actionBox.height / 2;
    const checkbox = checkboxBoxes
      .filter((item) => !item.checked && item.x < actionBox.x && Math.abs((item.y + item.height / 2) - y) < 24)
      .sort((a, b) => Math.abs((a.y + a.height / 2) - y) - Math.abs((b.y + b.height / 2) - y))[0];
    if (!checkbox) continue;
    await page.mouse.click(checkbox.x + checkbox.width / 2, checkbox.y + checkbox.height / 2);
    selected += 1;
    await page.waitForTimeout(80);
  }
  return selected;
}

async function openBatchAppointmentDialog(page) {
  const button = page.getByRole('button', { name: /批量新建预约/ }).first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click({ timeout: 10_000 });
  await page.waitForTimeout(1500);
}

async function fillAppointmentQuantities(page, quantity) {
  return page.evaluate((nextQuantity) => {
    const modal = Array.from(document.querySelectorAll('[role="dialog"], .MDL_outerWrapper_5-157-0, .modal, body')).find((node) => {
      const text = node.innerText || '';
      return /预约|送货/.test(text);
    }) || document.body;
    const inputs = Array.from(modal.querySelectorAll('input')).filter((input) => {
      const rect = input.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || input.disabled || input.readOnly) return false;
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      const hint = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''} ${input.name || ''}`;
      if (type === 'number') return true;
      if (/数量|件数|送货|预约|入库/.test(hint)) return true;
      return type === 'text' && /^[0-9]*$/.test(input.value || '') && rect.width <= 180;
    });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    for (const input of inputs) {
      if (setter) setter.call(input, String(nextQuantity));
      else input.value = String(nextQuantity);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return inputs.length;
  }, quantity);
}

async function runRule(page, context, rule, { dryRun }) {
  const meta = await resolveWarehouseGroup(context, rule);
  const goodsIds = await appointmentGoodsForRule(context, rule, meta);
  console.log(`规则 #${rule.id} ${rule.warehouseGroup}：${meta.warehouses.map((item) => item.warehouseName).join(', ')}，API 可预约候选 ${goodsIds.length} 个。`);

  await page.goto(APPOINTMENT_DELIVERY_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await applyFilters(page, rule, meta);

  const selectedRows = await selectVisibleAppointmentRows(page);
  if (!selectedRows) throw new Error(`规则 #${rule.id} 未能在页面中勾选到“去预约”行，请确认筛选条件和页面登录状态。`);
  console.log(`规则 #${rule.id} 已勾选 ${selectedRows} 行，准备批量新建预约。`);

  await openBatchAppointmentDialog(page);
  const filledInputs = await fillAppointmentQuantities(page, rule.quantity);
  if (!filledInputs) throw new Error(`规则 #${rule.id} 已打开批量预约弹窗，但没有找到可填写的预约件数输入框。`);
  console.log(`规则 #${rule.id} 已填写预约件数 ${rule.quantity} 到 ${filledInputs} 个输入框。`);
  if (dryRun) {
    console.log(`规则 #${rule.id} dry-run：停在批量预约弹窗，不点击确认提交。`);
    return;
  }
  throw new Error('真实提交暂未开放：请先完成 dry-run 校验，再显式实现 --commit 提交确认。');
}

await loadDotEnv();
const config = await readReportConfig();
const cliDryRun = hasArg('--dry-run') || !hasArg('--commit');
const dryRun = cliDryRun || config.reservation?.dryRun !== false;
const rules = selectRules(config);
if (!rules.length) throw new Error('没有可执行的预约规则；请启用规则，或 dry-run 时传 --include-disabled/--ids。');

const cfg = {
  cdpUrl: process.env.PDD_CDP_URL || 'http://127.0.0.1:9222',
  profileDir: path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile'),
  browserChannel: process.env.PDD_BROWSER_CHANNEL || 'chrome',
  chromiumSandbox: process.env.PDD_CHROMIUM_SANDBOX === 'true',
  headless: process.env.PDD_HEADLESS === 'true',
  waitForLogin: true,
  autoWaitForLogin: process.env.PDD_AUTO_WAIT_FOR_LOGIN !== 'false',
  loginWaitMs: Number(process.env.PDD_LOGIN_WAIT_MS || 180000),
  storageStatePath: pddStorageStatePath(ROOT),
  pddUrl: APPOINTMENT_DELIVERY_URL,
};

let browser;
let context;
try {
  ({ browser, context } = await createPddBrowserContext(cfg));
  const { page } = await loginAndSavePddStorageState(cfg, context);
  for (const rule of rules) {
    await runRule(page, context, rule, { dryRun });
  }
  console.log(`预约${dryRun ? '演练' : '执行'}完成：${rules.length} 条规则。`);
} finally {
  if (!dryRun) await closePddBrowserContext(browser, context);
  else if (browser) {
    // CDP 模式下仅断开 Playwright，保留页面供人工确认 dry-run 结果。
    await closePddBrowserContext(browser, context);
  }
}
