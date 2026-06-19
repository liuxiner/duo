import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { PDD_ORIGIN } from '../clients/pdd-client.mjs';
import { closeBlockingModals } from '../../scripts/pdd-page-tools.mjs';

export async function loadPddStorageState(storageStatePath) {
  if (!storageStatePath) return null;
  try {
    const text = await readFile(storageStatePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function pddStorageStateHasUsableCookies(storageState) {
  const nowSeconds = Date.now() / 1000;
  return Boolean((storageState?.cookies || []).some((cookie) => {
    const domain = String(cookie.domain || '');
    const isPddCookie = domain === 'mc.pinduoduo.com' || domain.endsWith('.pinduoduo.com');
    const notExpired = !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds;
    return isPddCookie && notExpired;
  }));
}

export async function pddSessionLooksReady(page) {
  const pageTitle = await page.title().catch(() => '');
  const pageUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const hasTable = await page.locator('table, [data-testid="beast-core-table"]').first().count().catch(() => 0);
  if (hasTable > 0) return true;

  const loginMarker = /请登录|账号登录|扫码登录|验证码登录|安全验证|人机验证|短信验证码|请完成验证|二维码/.test(
    `${pageTitle}\n${pageUrl}\n${bodyText}`
  );
  const loginUrl = /login|passport|verification|captcha/i.test(pageUrl);
  const cookies = await page.context().cookies(PDD_ORIGIN).catch(() => []);
  return cookies.length > 0 && !loginUrl && !loginMarker;
}

export async function waitForPddApiSession(page, cfg) {
  await closeBlockingModals(page);
  if (!cfg.waitForLogin) return;

  if (await pddSessionLooksReady(page)) {
    console.log('PDD login session detected. Continuing API sync.');
    return;
  }

  if (cfg.autoWaitForLogin) {
    console.log('Waiting for PDD login/verification before API sync...');
    const deadline = Date.now() + cfg.loginWaitMs;
    while (Date.now() < deadline) {
      await closeBlockingModals(page);
      if (await pddSessionLooksReady(page)) {
        console.log('PDD login session detected. Continuing API sync.');
        return;
      }
      await page.waitForTimeout(1500);
    }
    throw new Error(`Timed out after ${Math.round(cfg.loginWaitMs / 1000)} seconds waiting for PDD login.`);
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pageTitle = await page.title().catch(() => '');
    console.log('');
    console.log('PDD login/verification handoff required before API sync.');
    console.log(`Current page: ${pageTitle || '(no title)'}`);
    console.log(page.url());
    console.log('Please finish login/scan/verification in the opened browser window, then return here and press Enter.');

    const rl = createInterface({ input, output });
    await rl.question('');
    rl.close();

    await closeBlockingModals(page);
    if (await pddSessionLooksReady(page)) return;

    console.log('Re-opening PDD backend page after manual login...');
    await page.goto(cfg.pddUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  throw new Error('Still could not detect a usable PDD login session after manual login/verification handoff.');
}
