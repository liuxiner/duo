export const PDD_PAGE_SIZE = 100;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldPreserveModal(text) {
  return /报价|价格|商家报价|查看报价信息|选择司机/.test(normalizeText(text));
}

function serviceKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(value || '').split(/[?#]/)[0].replace(/\/$/, '');
  }
}

export async function getUniqueServicePage(context, serviceUrl) {
  const targetKey = serviceKey(serviceUrl);
  const matching = context.pages().filter((page) => serviceKey(page.url()) === targetKey);
  const page = matching.shift() || await context.newPage();
  for (const duplicate of matching) {
    await duplicate.close().catch(() => {});
  }
  if (serviceKey(page.url()) !== targetKey) {
    await page.goto(serviceUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await page.bringToFront().catch(() => {});
  return page;
}

export function disconnectPddBrowser(browser) {
  browser?._connection?.close();
}

export async function clickModalClose(modal, closeButton) {
  try {
    await closeButton.click({ timeout: 3000 });
  } catch (clickError) {
    if (!(await modal.isVisible({ timeout: 500 }).catch(() => false))) return;
    try {
      await closeButton.dispatchEvent('click', {}, { timeout: 1000 });
    } catch {
      if (await modal.isVisible({ timeout: 500 }).catch(() => false)) throw clickError;
      return;
    }
  }
  await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(async (error) => {
    if (await modal.isVisible({ timeout: 500 }).catch(() => false)) throw error;
  });
}

export async function closeBlockingModals(page) {
  const modals = page.locator('[data-testid="beast-core-modal"]:visible');
  const count = await modals.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const modal = modals.nth(index);
    const closeButton = modal.locator('[data-testid="beast-core-modal-icon-close"]').first();
    if (!(await closeButton.count().catch(() => 0))) continue;
    const title = normalizeText(
      await modal.locator('[class*="MDL_header"]').first().innerText().catch(() => '')
    );
    const modalText = normalizeText(await modal.innerText().catch(() => title));
    if (shouldPreserveModal(`${title} ${modalText}`)) continue;
    await clickModalClose(modal, closeButton).catch(async (error) => {
      if (await modal.isVisible({ timeout: 500 }).catch(() => false)) throw error;
    });
    console.log(`Closed blocking PDD modal${title ? `: ${title}` : ''}.`);
  }
}

export async function installBlockingModalGuard(page) {
  const modal = page.locator('[data-testid="beast-core-modal"]:visible').first();
  await page.addLocatorHandler(modal, async (visibleModal) => {
    const closeButton = visibleModal.locator('[data-testid="beast-core-modal-icon-close"]').first();
    if (!(await closeButton.count().catch(() => 0))) return;
    const title = normalizeText(
      await visibleModal.locator('[class*="MDL_header"]').first().innerText().catch(() => '')
    );
    const modalText = normalizeText(await visibleModal.innerText().catch(() => title));
    if (shouldPreserveModal(`${title} ${modalText}`)) return;
    await clickModalClose(visibleModal, closeButton);
    console.log(`Closed blocking PDD modal${title ? `: ${title}` : ''}.`);
  }, { noWaitAfter: true });
}

export async function getPddPageSize(page) {
  const pagination = page.locator('[data-testid="beast-core-pagination"]').first();
  const input = pagination.locator('.PGT_sizeChanger_5-157-0 input[data-testid="beast-core-select-htmlInput"]').first();
  const value = await input.inputValue({ timeout: 10000 }).catch(() => '');
  const size = Number(String(value).match(/\d+/)?.[0]);
  return Number.isFinite(size) ? size : null;
}

export async function setPddPageSize(page, targetSize = PDD_PAGE_SIZE) {
  const current = await getPddPageSize(page);
  if (current === targetSize) return targetSize;

  const pagination = page.locator('[data-testid="beast-core-pagination"]').first();
  const sizeChanger = pagination.locator('.PGT_sizeChanger_5-157-0').first();
  await sizeChanger.waitFor({ state: 'visible', timeout: 10000 });
  await closeBlockingModals(page);
  const header = sizeChanger.locator('[data-testid="beast-core-select-header"]').first();
  try {
    await header.click({ timeout: 3000 });
  } catch {
    await header.dispatchEvent('click');
  }

  const dropdown = page.locator('[data-testid="beast-core-portal"]:visible')
    .filter({ has: page.locator('[role="option"]') })
    .last();
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });
  const option = dropdown.locator('[role="option"]')
    .filter({ hasText: new RegExp(`^\\s*${targetSize}\\s*$`) })
    .first();
  if (!(await option.count())) {
    const available = (await dropdown.locator('[role="option"]').allInnerTexts()).join(', ');
    await page.keyboard.press('Escape');
    throw new Error(`分页器没有每页 ${targetSize} 条选项；可选项：${available}`);
  }

  try {
    await option.click({ timeout: 3000 });
  } catch {
    await option.dispatchEvent('click');
  }
  await page.waitForFunction((size) => {
    const paginationRoot = document.querySelector('[data-testid="beast-core-pagination"]');
    const input = paginationRoot?.querySelector('.PGT_sizeChanger_5-157-0 input[data-testid="beast-core-select-htmlInput"]');
    return Number(input?.value) === size;
  }, targetSize, { timeout: 10000 });
  return targetSize;
}
