import { closeBlockingModals, disconnectPddBrowser, getUniqueServicePage, installBlockingModalGuard } from '../../scripts/pdd-page-tools.mjs';
import { PDD_ORDER_MANAGEMENT_URL, savePddStorageState } from '../clients/pdd-client.mjs';
import { waitForPddApiSession } from './session.mjs';

export async function createPddBrowserContext(cfg) {
  const { chromium } = await import('playwright');
  let browser;
  let context;

  if (cfg.cdpUrl) {
    try {
      browser = await chromium.connectOverCDP(cfg.cdpUrl);
      context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: 1440, height: 960 },
        locale: 'zh-CN',
      });
      return { browser, context };
    } catch (cdpErr) {
      console.error(`CDP connection failed (${cdpErr.message || cdpErr}), falling back to persistent context.`);
    }
  }

  context = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: cfg.headless,
    channel: cfg.browserChannel || undefined,
    chromiumSandbox: cfg.chromiumSandbox,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
  });
  return { browser: null, context };
}

export async function closePddBrowserContext(browser, context) {
  try {
    if (browser) disconnectPddBrowser(browser);
    else await context.close();
  } catch (cleanupErr) {
    console.error('Browser cleanup error (safe to ignore):', cleanupErr.message || cleanupErr);
  }
}

export async function loginAndSavePddStorageState(cfg, context) {
  const pddUrl = cfg.pddUrl || PDD_ORDER_MANAGEMENT_URL;
  const page = await getUniqueServicePage(context, pddUrl);
  await installBlockingModalGuard(page);
  await page.goto(pddUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await closeBlockingModals(page);
  await waitForPddApiSession(page, { ...cfg, pddUrl });
  const storagePath = await savePddStorageState(context, cfg.storageStatePath);
  console.log(`Saved PDD storageState to ${storagePath}.`);
  return { page, storagePath };
}
