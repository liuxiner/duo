import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePddBrowserContext, createPddBrowserContext, loginAndSavePddStorageState } from '../pdd-automation/auth/login.mjs';
import {
  pddStorageStatePath,
  queryWarehouseGroupListWithExpress,
} from '../pdd-automation/clients/pdd-client.mjs';
import { withJobLock } from './job-lock.mjs';
import { closeBlockingModals } from './pdd-page-tools.mjs';

const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || process.cwd());
const APPOINTMENT_DELIVERY_URL = 'https://mc.pinduoduo.com/ddmc-mms/appointment-delivery';
const HEADER_MULTI_SELECTION_SELECTOR = 'th label[data-testid="beast-core-checkbox"], tr[data-testid="beast-core-table-header-tr"] label[data-testid="beast-core-checkbox"]';
const DEFAULT_AREA_IDS = { 浙江省: 31 };
const DEFAULT_RESERVATION_ITEMS = [
  {
    id: '1',
    region: '浙江省',
    warehouseGroup: '杭州仓组',
    centerWarehouses: ['杭州中心1仓', '杭州中心2仓'],
    driverMobile: '15090976592',
    quantity: 100,
    preferredHour: '21:00',
    enabled: false,
  },
  {
    id: '2',
    region: '浙江省',
    warehouseGroup: '宁波仓组',
    centerWarehouses: ['宁波1仓'],
    driverMobile: '13486621270',
    quantity: 100,
    preferredHour: '21:00',
    enabled: false,
  },
  {
    id: '3',
    region: '浙江省',
    warehouseGroup: '温州仓组',
    centerWarehouses: ['温州1仓'],
    driverMobile: '17767375369',
    quantity: 100,
    preferredHour: '21:00',
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

function maskMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : digits;
}

function beijingDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function beijingTimestamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function targetDeliveryDateKey() {
  return argValue('--delivery-date', '') || argValue('--target-date', '') || addDaysToDateKey(beijingDateKey(), 1);
}

function deliverySlotFor(rule, deliveryDate) {
  const [hour, minute] = normalizeTime(rule.preferredHour || '21:00', '21:00').split(':').map(Number);
  const endHour = (hour + 1) % 24;
  return {
    deliveryDate,
    pageText: `${deliveryDate} ${String(hour).padStart(2, '0')}:00~${String(hour).padStart(2, '0')}:59`,
    reportText: `${deliveryDate} ${String(hour).padStart(2, '0')}:00-${String(endHour).padStart(2, '0')}:00`,
    startTime: `${String(hour).padStart(2, '0')}:00`,
    endTime: `${String(endHour).padStart(2, '0')}:00`,
    minute,
  };
}

function defaultReservationItemFor(item = {}, index = 0) {
  const id = String(item.id || item.index || item['序号'] || index + 1);
  const group = normalizeText(item.warehouseGroup || item.warehouse || item['仓组'] || '');
  return DEFAULT_RESERVATION_ITEMS.find((candidate) => String(candidate.id) === id)
    || DEFAULT_RESERVATION_ITEMS.find((candidate) => group && normalizeText(candidate.warehouseGroup) === group)
    || DEFAULT_RESERVATION_ITEMS[index]
    || {};
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
  const defaults = defaultReservationItemFor(item, index);
  const configuredWarehouses = splitList(item.centerWarehouses || item.centerWarehouse || item['中心仓']);
  const quantity = Number(item.quantity ?? item['预约数量'] ?? defaults.quantity ?? 100);
  return {
    id: String(item.id || item.index || item['序号'] || defaults.id || index + 1),
    region: String(item.region || item['销售区域'] || defaults.region || '浙江省').trim(),
    warehouseGroup: String(item.warehouseGroup || item.warehouse || item['仓组'] || defaults.warehouseGroup || '').trim(),
    centerWarehouses: configuredWarehouses.length ? configuredWarehouses : [...(defaults.centerWarehouses || [])],
    driverMobile: String(item.driverMobile || item['司机号码'] || defaults.driverMobile || '').trim(),
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 100,
    preferredHour: normalizeTime(item.preferredHour || item['预约时间'] || item['送货时间'] || defaults.preferredHour, '21:00'),
    enabled: enabledFromValue(item.enabled ?? item['状态'], defaults.enabled ?? false),
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

async function selectVisibleDropdownByIndex(page, index, targetText) {
  const before = await page.evaluate(({ inputIndex, optionText }) => {
    const isVisible = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请选择"]')).filter(isVisible);
    const input = inputs[inputIndex];
    if (!input) return { opened: false, selected: false, reason: `找不到第 ${inputIndex + 1} 个筛选下拉框` };
    if (String(input.value || '').includes(optionText)) {
      return { opened: false, selected: true, value: input.value, reason: '' };
    }
    input.scrollIntoView({ block: 'center', inline: 'center' });
    input.click();
    return { opened: true, selected: false, value: input.value, reason: '' };
  }, { inputIndex: index, optionText: targetText });
  if (before.selected) return before;
  if (!before.opened) return before;
  await page.waitForTimeout(500);

  const selected = await page.evaluate((optionText) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const target = normalize(optionText);
    const isVisible = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const candidates = Array.from(document.querySelectorAll('[role="option"], li, [class*="option"], [class*="Option"], div, span'))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = normalize(node.innerText || node.textContent);
        return text.includes(target) && text.length <= Math.max(target.length + 80, 120);
      })
      .sort((a, b) => {
        const score = (node) => {
          const text = normalize(node.innerText || node.textContent);
          const className = String(node.className || '');
          return (text === target ? 100 : 0) + (/option|Option|item|Item/.test(className) ? 10 : 0) - text.length / 1000;
        };
        return score(b) - score(a);
      });
    const option = candidates[0];
    if (!option) return { selected: false, reason: `下拉选项中找不到 ${optionText}` };
    option.scrollIntoView({ block: 'center', inline: 'center' });
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
    option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
    option.click();
    return { selected: true, text: option.innerText || option.textContent || '' };
  }, targetText);
  if (!selected.selected) return selected;
  await page.waitForTimeout(600);
  return selected;
}

async function applyFilters(page, rule, meta, schedule) {
  await closeBlockingModals(page);
  const dateLabel = schedule.deliveryDate === beijingDateKey()
    ? `${schedule.deliveryDate} （今天）`
    : `${schedule.deliveryDate} （明天）`;
  const dateResult = await selectVisibleDropdownByIndex(page, 0, dateLabel).catch((error) => ({ selected: false, reason: error.message }));
  if (!dateResult.selected) {
    throw new Error(`销售日期筛选失败：${dateResult.reason || dateLabel}`);
  }
  const areaResult = await selectVisibleDropdownByIndex(page, 1, rule.region).catch((error) => ({ selected: false, reason: error.message }));
  if (!areaResult.selected) {
    throw new Error(`销售区域筛选失败：${areaResult.reason || rule.region}`);
  }
  const groupResult = await selectVisibleDropdownByIndex(page, 2, meta.group.warehouseGroupName).catch((error) => ({ selected: false, reason: error.message }));
  if (!groupResult.selected) {
    throw new Error(`仓组筛选失败：${groupResult.reason || meta.group.warehouseGroupName}`);
  }
  const query = page.getByRole('button', { name: /^查询$/ }).first();
  if (await query.count().catch(() => 0)) await query.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await closeBlockingModals(page);
  await page.waitForFunction(({ dateKey, groupName, warehouseNames }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请选择"]'))
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const dateValue = inputs[0]?.value || '';
    const groupValue = inputs[2]?.value || '';
    const body = document.body.innerText || '';
    return /共有\s*\d+\s*条/.test(body)
      && normalize(dateValue).includes(normalize(dateKey))
      && normalize(groupValue).includes(normalize(groupName))
      && warehouseNames.some((name) => normalize(body).includes(normalize(name)));
  }, { dateKey: schedule.deliveryDate, groupName: meta.group.warehouseGroupName, warehouseNames: meta.warehouses.map((item) => item.warehouseName) }, { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const filterState = await page.evaluate(({ dateKey, groupName, warehouseNames }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请选择"]'))
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const dateValue = inputs[0]?.value || '';
    const groupValue = inputs[2]?.value || '';
    const body = document.body.innerText || '';
    return {
      dateValue,
      groupValue,
      dateMatched: normalize(dateValue).includes(normalize(dateKey)),
      groupMatched: normalize(groupValue).includes(normalize(groupName)),
      warehouseMatched: warehouseNames.some((name) => normalize(body).includes(normalize(name))),
    };
  }, { dateKey: schedule.deliveryDate, groupName: meta.group.warehouseGroupName, warehouseNames: meta.warehouses.map((item) => item.warehouseName) });
  if (!filterState.dateMatched) {
    throw new Error(`销售日期筛选未生效：当前筛选值为 ${filterState.dateValue || '(空)'}，目标为 ${schedule.deliveryDate}`);
  }
  if (!filterState.groupMatched) {
    throw new Error(`仓组筛选未生效：当前筛选值为 ${filterState.groupValue || '(空)'}，目标为 ${meta.group.warehouseGroupName}`);
  }
  if (!filterState.warehouseMatched) {
    console.log(`仓组筛选后列表未展开目标中心仓明细，继续以批量预约页可填写仓库行校验：${meta.warehouses.map((item) => item.warehouseName).join(', ')}。`);
  }
}

async function readAppointmentTotalCount(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const matches = Array.from(bodyText.matchAll(/共有\s*([0-9,]+)\s*条/g));
    if (!matches.length) return null;
    const value = matches[matches.length - 1][1].replace(/,/g, '');
    const count = Number(value);
    return Number.isFinite(count) ? count : null;
  });
}

async function readAppointmentListGoodsIds(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    return [...new Set(Array.from(bodyText.matchAll(/ID[:\s]+(\d+)/g)).map((match) => match[1]))];
  });
}

async function readAppointmentSelectionState(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isDisabledCheckbox = (checkbox) => {
      const input = checkbox?.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      const className = String(checkbox?.className || '');
      return Boolean(
        input?.disabled
        || checkbox?.getAttribute('aria-disabled') === 'true'
        || /(^|\s)(CBX_)?disabled[_\s]/i.test(className)
      );
    };
    const isCheckedCheckbox = (checkbox) => {
      const input = checkbox?.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      return checkbox?.getAttribute('data-checked') === 'true' || Boolean(input?.checked);
    };
    const centerOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const checkbox = Array.from(document.querySelectorAll('th label[data-testid="beast-core-checkbox"], tr[data-testid="beast-core-table-header-tr"] label[data-testid="beast-core-checkbox"]'))
      .find((item) => isVisible(item));
    const rows = Array.from(document.querySelectorAll('tbody tr[data-testid^="beast-core-table-body-tr"], tbody tr'))
      .filter((row) => !row.closest('thead') && !row.matches('[data-testid="beast-core-table-header-tr"]') && isVisible(row));
    const rowCheckboxes = rows
      .map((row, index) => {
        const rowCheckbox = row.querySelector('label[data-testid="beast-core-checkbox"]');
        if (!rowCheckbox || !isVisible(rowCheckbox)) return null;
        const point = centerOf(rowCheckbox);
        return {
          index,
          x: point.x,
          y: point.y,
          checked: isCheckedCheckbox(rowCheckbox),
          disabled: isDisabledCheckbox(rowCheckbox),
          text: String(row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        };
      })
      .filter(Boolean);
    const batchButton = Array.from(document.querySelectorAll('button'))
      .find((button) => /批量新建预约/.test(button.innerText || button.textContent || ''));
    const headerPoint = checkbox && isVisible(checkbox) ? centerOf(checkbox) : null;
    return {
      header: checkbox ? {
        checked: isCheckedCheckbox(checkbox),
        disabled: isDisabledCheckbox(checkbox),
        visible: isVisible(checkbox),
        x: headerPoint?.x,
        y: headerPoint?.y,
      } : null,
      rows: rowCheckboxes,
      checkedRows: rowCheckboxes.filter((item) => item.checked).length,
      selectableRows: rowCheckboxes.filter((item) => !item.disabled).length,
      visibleRows: rows.length,
      batchActive: Boolean(batchButton && !batchButton.disabled),
    };
  });
}

async function selectAppointmentRows(page, expectedCount) {
  let state = await readAppointmentSelectionState(page);
  if (state.batchActive && (state.checkedRows === expectedCount || state.header?.checked)) {
    return { selectedCount: state.checkedRows || expectedCount, method: 'existing' };
  }

  if (!state.header?.visible) {
    return { selectedCount: state.checkedRows, method: 'header', reason: '找不到表头 multi selection' };
  }
  if (state.header.disabled) {
    return {
      selectedCount: state.checkedRows,
      method: 'header',
      reason: `页面共有 ${expectedCount} 条，但表头 multi selection 处于禁用态`,
    };
  }

  const headerIcon = page.locator('th [data-testid="beast-core-checkbox-checkIcon"], tr[data-testid="beast-core-table-header-tr"] [data-testid="beast-core-checkbox-checkIcon"]').first();
  if (state.batchActive || state.header.checked || state.checkedRows) {
    await headerIcon.click({ force: true, timeout: 3000 }).catch(() => page.mouse.click(state.header.x, state.header.y));
    await page.waitForFunction(() => {
      const batchButton = Array.from(document.querySelectorAll('button'))
        .find((button) => /批量新建预约/.test(button.innerText || button.textContent || ''));
      const checkbox = Array.from(document.querySelectorAll('th label[data-testid="beast-core-checkbox"], tr[data-testid="beast-core-table-header-tr"] label[data-testid="beast-core-checkbox"]'))
        .find((item) => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const input = checkbox?.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      return Boolean(batchButton?.disabled)
        && checkbox?.getAttribute('data-checked') !== 'true'
        && !input?.checked;
    }, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    state = await readAppointmentSelectionState(page);
  }

  const waitForSelection = () => page.waitForFunction(() => {
      const batchButton = Array.from(document.querySelectorAll('button'))
        .find((button) => /批量新建预约/.test(button.innerText || button.textContent || ''));
      const checkboxes = Array.from(document.querySelectorAll('th label[data-testid="beast-core-checkbox"], tr[data-testid="beast-core-table-header-tr"] label[data-testid="beast-core-checkbox"]'));
      const checkbox = checkboxes.find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const input = checkbox?.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      return Boolean(batchButton && !batchButton.disabled)
        || checkbox?.getAttribute('data-checked') === 'true'
        || Boolean(input?.checked);
    }, { timeout: 3000 }).catch(() => {});
  const headerLabel = page.locator(HEADER_MULTI_SELECTION_SELECTOR).first();
  const headerInput = page.locator('th input[type="checkbox"], th input[mode="checkbox"], tr[data-testid="beast-core-table-header-tr"] input[type="checkbox"], tr[data-testid="beast-core-table-header-tr"] input[mode="checkbox"]').first();
  const clickAttempts = [
    () => headerIcon.click({ force: true, timeout: 3000 }),
    () => headerInput.click({ force: true, timeout: 3000 }),
    () => headerLabel.click({ force: true, timeout: 3000 }),
    () => headerIcon.dispatchEvent('click', {}, { timeout: 3000 }),
    () => headerInput.dispatchEvent('click', {}, { timeout: 3000 }),
    () => headerLabel.dispatchEvent('click', {}, { timeout: 3000 }),
    () => page.mouse.click(state.header.x, state.header.y),
    () => page.evaluate(() => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const checkbox = Array.from(document.querySelectorAll('th label[data-testid="beast-core-checkbox"], tr[data-testid="beast-core-table-header-tr"] label[data-testid="beast-core-checkbox"]'))
        .find((item) => isVisible(item));
      if (!checkbox) return false;
      const icon = checkbox.querySelector('[data-testid="beast-core-checkbox-checkIcon"]');
      const input = checkbox.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      const fire = (node, type) => node?.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
      for (const target of [icon, input, checkbox]) {
        fire(target, 'mousedown');
        fire(target, 'mouseup');
        fire(target, 'click');
      }
      input?.click?.();
      checkbox.click();
      return true;
    }),
  ];
  for (const clickAttempt of clickAttempts) {
    await clickAttempt().catch(() => {});
    await waitForSelection();
    state = await readAppointmentSelectionState(page);
    if (state.batchActive || state.header?.checked || state.checkedRows) break;
  }
  await page.waitForTimeout(300);

  state = await readAppointmentSelectionState(page);
  if (!state.batchActive) {
    return {
      selectedCount: state.checkedRows,
      method: 'header',
      reason: `已点击表头 multi selection，但批量新建预约按钮未启用；当前已选 ${state.checkedRows} 条`,
    };
  }
  return { selectedCount: expectedCount, observedSelectedCount: state.checkedRows, method: 'header' };
}

async function openBatchAppointmentFromCurrentList(page, expectedCount) {
  await closeBlockingModals(page);
  const selectState = await selectAppointmentRows(page, expectedCount);
  if (selectState.selectedCount !== expectedCount) {
    return { opened: false, selectedCount: selectState.selectedCount, reason: selectState.reason || '选中行数不匹配' };
  }

  const button = page.getByRole('button', { name: /批量新建预约/ }).first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  const disabled = await button.evaluate((node) => node.disabled).catch(() => true);
  if (disabled) return { opened: false, selectedCount: selectState.selectedCount, reason: '批量新建预约按钮仍为禁用态' };
  await button.click({ timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await closeBlockingModals(page);
  await page.waitForTimeout(1500);
  return { opened: true, selectedCount: selectState.selectedCount, reason: '' };
}

function batchCreateAppointmentUrl(meta, goodsIds, schedule) {
  const url = new URL(`${APPOINTMENT_DELIVERY_URL}/create-appointment`);
  url.searchParams.set('areaId', String(meta.areaId));
  url.searchParams.set('date', schedule.deliveryDate);
  url.searchParams.set('goodsId', goodsIds.join(','));
  url.searchParams.set('warehouseGroupId', String(meta.group.warehouseGroupId));
  url.searchParams.set('warehouseGroupName', meta.group.warehouseGroupName);
  return url.toString();
}

async function openBatchAppointmentByGoodsIds(page, meta, goodsIds, schedule) {
  await page.goto(batchCreateAppointmentUrl(meta, goodsIds, schedule), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await closeBlockingModals(page);
  await page.waitForTimeout(1500);
}

async function selectDriver(page, rule) {
  await closeBlockingModals(page);
  const mobile = String(rule.driverMobile || '').trim();
  if (!mobile) return { selected: false, label: '' };
  const maskedMobile = maskMobile(mobile);
  if (!maskedMobile) return { selected: false, label: '' };

  const selectedAlready = await page.evaluate((masked) => {
    const text = document.body.innerText || '';
    return text.includes(masked) && !text.includes('请先选择司机');
  }, maskedMobile).catch(() => false);
  if (selectedAlready) return { selected: true, label: maskedMobile };

  if (typeof page.removeLocatorHandler === 'function') {
    await page.removeLocatorHandler(page.locator('[data-testid="beast-core-modal"]:visible').first()).catch(() => {});
  }
  await page.getByText('选择司机', { exact: true }).click({ timeout: 10_000 });
  await page.waitForSelector('[data-testid="beast-core-modal"]', { state: 'visible', timeout: 10_000 });

  const searchResult = await page.evaluate((keyword) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const modal = Array.from(document.querySelectorAll('[data-testid="beast-core-modal"]')).find(isVisible);
    const inputs = Array.from(modal?.querySelectorAll('input') || [])
      .filter((input) => isVisible(input) && !input.disabled && !input.readOnly);
    const input = inputs.find((candidate) => /司机|手机|电话|搜索|请输入/.test(`${candidate.placeholder || ''} ${candidate.getAttribute('aria-label') || ''}`))
      || inputs[0];
    if (!input) return { searched: false, reason: '司机选择弹窗未找到搜索输入框' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    if (setter) setter.call(input, keyword);
    else input.value = keyword;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    const searchButton = Array.from(modal.querySelectorAll('button, a, [role="button"]'))
      .find((node) => /查询|搜索/.test(normalize(node.innerText || node.textContent)));
    searchButton?.click();
    return { searched: true, reason: '' };
  }, mobile);
  if (!searchResult.searched) throw new Error(searchResult.reason);
  await page.waitForTimeout(1200);

  const choice = await page.evaluate((masked) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const modal = Array.from(document.querySelectorAll('[data-testid="beast-core-modal"]')).find(isVisible);
    const items = Array.from(modal?.querySelectorAll('[class*="driver-select-modal_driver-item"]') || [])
      .filter((node) => isVisible(node) && normalize(node.innerText).includes(masked) && normalize(node.innerText).includes('选择'));
    if (!items.length) return { selected: false, reason: `搜索后未找到 ${masked} 对应司机` };
    if (items.length > 1) return { selected: false, reason: `搜索后 ${masked} 匹配到 ${items.length} 个司机，请检查司机号码是否唯一` };
    const item = items[0];
    const button = Array.from(item.querySelectorAll('button, a, [role="button"]'))
      .find((node) => normalize(node.innerText || node.textContent) === '选择');
    if (!button) return { selected: false, reason: `搜索到 ${masked}，但未找到该行“选择”按钮` };
    const text = normalize(item.innerText);
    button.click();
    return { selected: true, text };
  }, maskedMobile);
  if (!choice.selected) {
    throw new Error(`未精准选择司机手机号 ${mobile}（${maskedMobile}）：${choice.reason}`);
  }

  await page.waitForSelector('[data-testid="beast-core-modal"]', { state: 'hidden', timeout: 10_000 }).catch(() => {});
  await closeBlockingModals(page);
  await page.waitForTimeout(800);
  return { selected: true, label: choice.text };
}

async function countCreateAppointmentGoods(page) {
  return page.evaluate(() => {
    const url = new URL(location.href);
    const urlGoodsIds = (url.searchParams.get('goodsId') || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (urlGoodsIds.length) return new Set(urlGoodsIds).size;
    const bodyText = document.body.innerText || '';
    return new Set(Array.from(bodyText.matchAll(/ID:\s*(\d+)/g)).map((match) => match[1])).size;
  });
}

async function fillAppointmentQuantities(page, quantity, centerWarehouses) {
  const selection = await page.evaluate(({ warehouses }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const warehouseAliases = [...new Set(warehouses
      .flatMap((warehouse) => String(warehouse || '').split(/[-—]/))
      .map(normalize)
      .filter(Boolean))];
    const rowMatchesWarehouse = (rowText) => {
      const normalizedRow = normalize(rowText);
      return !warehouseAliases.length || warehouseAliases.some((warehouse) => normalizedRow.includes(warehouse));
    };
    const isChecked = (checkbox) => {
      const input = checkbox?.querySelector('input[type="checkbox"], input[mode="checkbox"]');
      return checkbox?.getAttribute('data-checked') === 'true' || Boolean(input?.checked);
    };
    const clickCheckbox = (checkbox) => {
      const target = checkbox?.querySelector('[data-testid="beast-core-checkbox-checkIcon"]') || checkbox?.querySelector('input') || checkbox;
      for (const node of [target, checkbox]) {
        if (!node) continue;
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
      }
      checkbox?.click?.();
    };
    let matchedRows = 0;
    let alreadyChecked = 0;
    let clickedRows = 0;
    const missingCheckboxRows = [];
    for (const row of Array.from(document.querySelectorAll('tbody tr, tr'))) {
      const rowText = row.innerText || '';
      if (!/本次预约/.test(rowText) || !rowMatchesWarehouse(rowText)) continue;
      matchedRows += 1;
      const checkbox = row.querySelector('label[data-testid="beast-core-checkbox"]');
      if (!checkbox) {
        missingCheckboxRows.push(rowText.replace(/\s+/g, ' ').trim().slice(0, 120));
        continue;
      }
      if (isChecked(checkbox)) {
        alreadyChecked += 1;
      } else {
        clickCheckbox(checkbox);
        clickedRows += 1;
      }
    }
    return { matchedRows, alreadyChecked, clickedRows, missingCheckboxRows };
  }, { warehouses: centerWarehouses });

  await page.waitForTimeout(600);

  const fillResult = await page.evaluate(({ nextQuantity, warehouses }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const warehouseTargets = warehouses.map(normalize).filter(Boolean);
    const warehouseAliases = [...new Set(warehouses
      .flatMap((warehouse) => String(warehouse || '').split(/[-—]/))
      .map(normalize)
      .filter(Boolean))];
    const rowMatchesWarehouse = (rowText) => {
      const normalizedRow = normalize(rowText);
      return !warehouseAliases.length || warehouseAliases.some((warehouse) => normalizedRow.includes(warehouse));
    };
    const rows = Array.from(document.querySelectorAll('tbody tr, tr'))
      .filter((row) => /本次预约/.test(row.innerText || '') && rowMatchesWarehouse(row.innerText || ''));
    const inputs = [];
    const stillDisabledRows = [];
    for (const row of rows) {
      const input = Array.from(row.querySelectorAll('input'))
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const type = String(candidate.type || '').toLowerCase();
          return rect.width > 0 && rect.height > 0 && type !== 'checkbox' && candidate.getAttribute('mode') !== 'checkbox';
        });
      if (input && !input.disabled && !input.readOnly) {
        inputs.push(input);
      } else {
        stillDisabledRows.push((row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120));
      }
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    for (const input of inputs) {
      if (setter) setter.call(input, String(nextQuantity));
      else input.value = String(nextQuantity);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: '1', bubbles: true }));
    }
    return {
      filledInputs: inputs.length,
      targetWarehouses: warehouseTargets.length || warehouseAliases.length,
      stillDisabledRows,
    };
  }, { nextQuantity: quantity, warehouses: centerWarehouses });

  return { ...selection, ...fillResult };
}

async function selectDeliveryTimes(page, schedule, centerWarehouses) {
  const result = {
    selectedWarehouses: [],
    optionText: schedule.pageText,
    reportText: schedule.reportText,
  };
  for (const warehouseName of centerWarehouses) {
    await closeBlockingModals(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const opened = await page.evaluate((targetWarehouse) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
      const target = normalize(targetWarehouse);
      const isVisible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const row = Array.from(document.querySelectorAll('[class*="Form_item_"], [class*="Form_item "]'))
        .map((node) => {
          const input = node.querySelector('input[placeholder="请选择"]');
          if (!input || !isVisible(input)) return null;
          const labelNode = node.querySelector('[class*="Form_itemLabel"], [class*="Form_label"], label');
          const labelText = normalize(labelNode?.innerText || labelNode?.textContent || '');
          const ownText = normalize(node.innerText || node.textContent);
          const matched = labelText === `*${target}`
            || labelText === target
            || (labelText.includes(target) && !labelText.replace(`*${target}`, '').replace(target, ''));
          if (!matched) return null;
          const rect = node.getBoundingClientRect();
          return { node, input, y: rect.y, text: ownText, labelText };
        })
        .filter(Boolean)
        .sort((a, b) => Math.abs(a.y - window.innerHeight * 0.7) - Math.abs(b.y - window.innerHeight * 0.7))[0];
      if (!row) return { opened: false, reason: `找不到 ${targetWarehouse} 的到货时间选择框` };
      row.input.scrollIntoView({ block: 'center', inline: 'center' });
      row.input.click();
      return { opened: true, reason: '' };
    }, warehouseName);
    if (!opened.opened) throw new Error(opened.reason);
    await page.waitForTimeout(600);

    const selected = await page.evaluate((optionText) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
      const target = normalize(optionText);
      const isVisible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const allOptions = Array.from(document.querySelectorAll('li, [role="option"], [class*="item"], [class*="Item"], div, span'))
        .filter((node) => normalize(node.innerText || node.textContent).includes(target));
      const disabledMatch = allOptions.find((node) => /disabled|notAvailable/i.test(String(node.className || '')) || /不可|约满|未配置/.test(node.innerText || node.textContent || ''));
      const option = allOptions
        .filter((node) => !/disabled/i.test(String(node.className || '')))
        .sort((a, b) => {
          const score = (node) => {
            const text = normalize(node.innerText || node.textContent);
            const rect = node.getBoundingClientRect();
            return (isVisible(node) ? 100 : 0)
              + (/^LI$/.test(node.tagName) || /option|item|Item/.test(String(node.className || '')) ? 20 : 0)
              + (/可约/.test(text) ? 10 : 0)
              - text.length / 1000
              - Math.max(0, -rect.y) / 1000;
          };
          return score(b) - score(a);
        })[0];
      if (!option) {
        return {
          selected: false,
          reason: disabledMatch
            ? `${optionText} 不可选：${String(disabledMatch.innerText || disabledMatch.textContent || '').replace(/\s+/g, ' ').trim()}`
            : `下拉选项中找不到 ${optionText}`,
        };
      }
      const optionTextFound = String(option.innerText || option.textContent || '').replace(/\s+/g, ' ').trim();
      if (/不可|约满|未配置/.test(optionTextFound) && !/可约/.test(optionTextFound)) {
        return { selected: false, reason: `${optionText} 不可选：${optionTextFound}` };
      }
      option.scrollIntoView({ block: 'center', inline: 'center' });
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
      option.click();
      return { selected: true, text: optionTextFound };
    }, schedule.pageText);
    if (!selected.selected) throw new Error(`到货时间选择失败（${warehouseName}）：${selected.reason}`);
    await page.waitForTimeout(500);
    result.selectedWarehouses.push(warehouseName);
  }

  const values = await page.evaluate((warehouses) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    return warehouses.map((warehouseName) => {
      const target = normalize(warehouseName);
      const row = Array.from(document.querySelectorAll('[class*="Form_item_"], [class*="Form_item "]'))
        .find((node) => {
          const input = node.querySelector('input[placeholder="请选择"]');
          if (!input) return false;
          const labelNode = node.querySelector('[class*="Form_itemLabel"], [class*="Form_label"], label');
          const labelText = normalize(labelNode?.innerText || labelNode?.textContent || '');
          return labelText === `*${target}` || labelText === target;
        });
      const input = row?.querySelector('input[placeholder="请选择"]');
      return { warehouseName, value: input?.value || '' };
    });
  }, centerWarehouses);
  for (const item of values) {
    if (!item.value.includes(schedule.pageText)) {
      throw new Error(`到货时间校验失败：${item.warehouseName} 当前为 ${item.value || '(空)'}，目标为 ${schedule.pageText}`);
    }
  }
  return result;
}

async function closePostSubmitModals(page) {
  const result = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const clickNode = (node) => {
      if (!node) return false;
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
      node.click?.();
      return true;
    };
    const modals = Array.from(document.querySelectorAll('[data-testid="beast-core-modal"]'))
      .filter(isVisible)
      .map((modal) => {
        const title = normalize(modal.querySelector('[class*="MDL_header"]')?.innerText || '');
        const text = normalize(modal.innerText || title);
        const buttons = Array.from(modal.querySelectorAll('button, a, [role="button"]'))
          .filter(isVisible)
          .map((button) => normalize(button.innerText || button.textContent))
          .filter(Boolean);
        return { modal, title, text, buttons };
      });
    const handled = [];
    for (const item of modals.reverse()) {
      if (/选择司机|司机选择/.test(`${item.title} ${item.text}`)) {
        handled.push({ title: item.title, text: item.text, buttons: item.buttons, closed: false, preserved: true });
        continue;
      }
      const closeIcon = item.modal.querySelector('[data-testid="beast-core-modal-icon-close"]');
      const actionButton = Array.from(item.modal.querySelectorAll('button, a, [role="button"]'))
        .filter(isVisible)
        .find((button) => /^(我知道了|知道了|好的|确定|确认|关闭|完成|返回列表)$/.test(normalize(button.innerText || button.textContent)));
      const closed = clickNode(closeIcon || actionButton);
      handled.push({ title: item.title, text: item.text, buttons: item.buttons, closed, preserved: false });
    }
    return handled;
  }).catch(() => []);
  await page.waitForTimeout(600);
  return result;
}

async function submitAppointment(page) {
  await closeBlockingModals(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  const confirmButton = page.getByRole('button', { name: /^确认$/ }).last();
  await confirmButton.waitFor({ state: 'visible', timeout: 10_000 });
  const disabled = await confirmButton.evaluate((node) => Boolean(node.disabled)).catch(() => true);
  if (disabled) throw new Error('确认按钮处于禁用态，未提交。');
  try {
    await confirmButton.click({ timeout: 10_000 });
  } catch (error) {
    await closeBlockingModals(page);
    await page.waitForTimeout(500);
    const stillDisabled = await confirmButton.evaluate((node) => Boolean(node.disabled)).catch(() => true);
    if (stillDisabled) throw error;
    await confirmButton.click({ force: true, timeout: 5000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const modalResults = await closePostSubmitModals(page);
  await closeBlockingModals(page);
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const modalText = modalResults.map((item) => item.text).filter(Boolean).join('\n');
  const statusText = `${modalText}\n${bodyText}`;
  const successText = (statusText.match(/(预约成功|提交成功|新建成功|创建成功|操作成功|已预约|预约已提交|预约创建成功)/) || [])[1] || '';
  const errorText = (statusText.match(/(预约失败|提交失败|创建失败|错误|异常|不可预约|请选择(?:司机|到货时间|预约时间|送货时间)[^。\n]*)/) || [])[1] || '';
  if (errorText && !successText) throw new Error(`提交后页面提示异常：${errorText}`);
  return { successText: successText || '已点击确认提交', modalResults, pageText: bodyText.slice(-500) };
}

async function runRule(page, context, rule, { dryRun }) {
  const meta = await resolveWarehouseGroup(context, rule);
  const schedule = deliverySlotFor(rule, targetDeliveryDateKey());
  const warehouseNames = meta.warehouses.map((item) => item.warehouseName);
  const createdAt = beijingTimestamp();
  console.log(`规则 #${rule.id} ${rule.warehouseGroup}：${warehouseNames.join(', ')}。`);
  console.log(`规则 #${rule.id} 目标销售/送货日期：${schedule.deliveryDate}；目标送货时间：${schedule.reportText}（页面选项 ${schedule.pageText}）。`);
  if (!rule.driverMobile) {
    throw new Error(`规则 #${rule.id} ${rule.warehouseGroup} 未配置司机号码，请在预约规则里填写司机号码后再测试。`);
  }

  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
  await page.goto(APPOINTMENT_DELIVERY_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await applyFilters(page, rule, meta, schedule);
  const expectedCount = await readAppointmentTotalCount(page);
  if (!Number.isFinite(expectedCount)) {
    throw new Error(`规则 #${rule.id} 未读取到页面“共有 xx 条”，无法校验预约数量。`);
  }
  console.log(`规则 #${rule.id} 页面共有 ${expectedCount} 条。`);
  if (expectedCount <= 0) {
    console.log(`规则 #${rule.id} 当前没有可预约商品，跳过预约送货 dry-run。`);
    return;
  }
  const listGoodsIds = await readAppointmentListGoodsIds(page);
  if (listGoodsIds.length !== expectedCount) {
    throw new Error(`规则 #${rule.id} 列表商品 ID 校验失败：页面共有 ${expectedCount} 条，但读取到 ${listGoodsIds.length} 个商品 ID。`);
  }

  const pageEntry = await openBatchAppointmentFromCurrentList(page, expectedCount).catch((error) => ({
    opened: false,
    reason: error.message || String(error),
  }));
  if (!pageEntry.opened) {
    throw new Error(`规则 #${rule.id} 页面共有 ${expectedCount} 条，但批量入口未启用：${pageEntry.reason}`);
  }
  console.log(`规则 #${rule.id} 已通过表头全选进入批量新建预约页，预期预约 ${expectedCount} 条。`);

  let appointmentGoodsCount = await countCreateAppointmentGoods(page);
  if (appointmentGoodsCount !== expectedCount) {
    console.log(`规则 #${rule.id} 批量页商品数 ${appointmentGoodsCount} 与列表 ${expectedCount} 不一致，按列表商品 ID 重建批量预约页。`);
    await openBatchAppointmentByGoodsIds(page, meta, listGoodsIds, schedule);
    appointmentGoodsCount = await countCreateAppointmentGoods(page);
    if (appointmentGoodsCount !== expectedCount) {
      throw new Error(`规则 #${rule.id} 预约商品数校验失败：列表页面共有 ${expectedCount} 条，但批量预约页包含 ${appointmentGoodsCount} 条。`);
    }
  }
  const driverResult = await selectDriver(page, rule);
  if (driverResult.selected) {
    console.log(`规则 #${rule.id} 已选择司机：${maskMobile(rule.driverMobile)}。`);
  }
  const fillResult = await fillAppointmentQuantities(page, rule.quantity, meta.warehouses.map((item) => item.warehouseName));
  const { filledInputs, targetWarehouses } = fillResult;
  if (!filledInputs) {
    const disabledHint = fillResult.stillDisabledRows?.length ? `；仍未解锁的行：${fillResult.stillDisabledRows.slice(0, 3).join(' / ')}` : '';
    throw new Error(`规则 #${rule.id} 已打开批量预约页，但没有找到可填写的预约件数输入框${disabledHint}。`);
  }
  const expectedInputCount = expectedCount * Math.max(targetWarehouses, 1);
  if (filledInputs !== expectedInputCount) {
    const disabledHint = fillResult.stillDisabledRows?.length ? `，仍未解锁 ${fillResult.stillDisabledRows.length} 行` : '';
    throw new Error(`规则 #${rule.id} 预约填写校验失败：${expectedCount} 条商品 × ${targetWarehouses} 个中心仓，应填写 ${expectedInputCount} 个输入框，实际填写 ${filledInputs} 个${disabledHint}。`);
  }
  console.log(`规则 #${rule.id} 已逐商品勾选 ${fillResult.matchedRows} 个仓库行，填写预约件数 ${rule.quantity} 到 ${filledInputs} 个输入框（${expectedCount} 条商品 × ${targetWarehouses} 个中心仓）。`);
  const deliveryResult = await selectDeliveryTimes(page, schedule, warehouseNames);
  console.log(`规则 #${rule.id} 已选择到货时间：${deliveryResult.reportText}（${deliveryResult.selectedWarehouses.join(', ')}）。`);
  const totalReservedQuantity = filledInputs * rule.quantity;
  const reportLines = [
    `预约送货上报：${dryRun ? '演练' : '已提交'}`,
    `仓库：${rule.warehouseGroup}（${warehouseNames.join('、')}）`,
    `司机：${maskMobile(rule.driverMobile)}`,
    `商品数：${expectedCount}`,
    `预约件数：每个商品每个中心仓 ${rule.quantity} 件，共 ${totalReservedQuantity} 件`,
    `送货时间：${schedule.reportText}`,
    `页面时间选项：${schedule.pageText}`,
    `预约时间：${createdAt}`,
  ];
  if (dryRun) {
    console.log(reportLines.join('\n'));
    console.log(`规则 #${rule.id} dry-run：停在批量新建预约页，不点击确认提交。`);
    return { submitted: false, expectedCount, filledInputs, totalReservedQuantity, schedule, createdAt };
  }
  const submitResult = await submitAppointment(page);
  console.log(`规则 #${rule.id} 已点击确认提交：${submitResult.successText}。`);
  console.log(reportLines.join('\n'));
  return { submitted: true, expectedCount, filledInputs, totalReservedQuantity, schedule, createdAt, submitResult };
}

await loadDotEnv();
const config = await readReportConfig();
const commit = hasArg('--commit');
const cliDryRun = hasArg('--dry-run') || !commit;
const dryRun = commit ? false : (cliDryRun || config.reservation?.dryRun !== false);
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
await withJobLock(`delivery-appointment:${dryRun ? 'dry-run' : 'commit'}`, async () => {
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
}, { root: ROOT });

if (dryRun) process.exit(0);
