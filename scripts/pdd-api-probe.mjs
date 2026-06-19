import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closeBlockingModals, getUniqueServicePage } from './pdd-page-tools.mjs';
import { createPddBrowserContext, closePddBrowserContext } from '../pdd-automation/auth/login.mjs';
import {
  PDD_ENDPOINTS,
  PDD_ORDER_MANAGEMENT_URL,
  pddStorageStatePath,
  savePddStorageState,
  writeJsonSnapshot,
} from './pdd-api-client.mjs';

const ROOT = process.cwd();

async function loadDotEnv(file = '.env') {
  let text;
  try {
    text = await readFile(path.resolve(ROOT, file), 'utf8');
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

function envBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function envInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function config() {
  return {
    pddUrl: process.env.PDD_ORDER_MANAGEMENT_URL || PDD_ORDER_MANAGEMENT_URL,
    cdpUrl: process.env.PDD_CDP_URL || '',
    profileDir: path.resolve(ROOT, process.env.PDD_BROWSER_PROFILE_DIR || '.cache/pdd-chrome-profile'),
    browserChannel: process.env.PDD_BROWSER_CHANNEL || '',
    chromiumSandbox: envBool(process.env.PDD_CHROMIUM_SANDBOX, true),
    headless: envBool(process.env.PDD_HEADLESS, false),
    probeMs: envInt(process.env.PDD_API_PROBE_MS, 60_000),
    outputJson: path.resolve(ROOT, process.env.PDD_API_PROBE_JSON || 'data/pdd-api-probe.json'),
    storageStatePath: pddStorageStatePath(ROOT),
  };
}

function isInterestingPddApi(url) {
  if (!url.startsWith('https://mc.pinduoduo.com/')) return false;
  return Object.values(PDD_ENDPOINTS).some((endpoint) => url.includes(endpoint))
    || /\/(?:appointment|schedule|Punishment|warehouse|area)\//i.test(url);
}

async function main() {
  await loadDotEnv();
  const cfg = config();
  const { browser, context } = await createPddBrowserContext(cfg);
  const captures = [];
  try {
    const page = await getUniqueServicePage(context, cfg.pddUrl);
    page.on('response', async (response) => {
      const url = response.url();
      if (!isInterestingPddApi(url)) return;
      const request = response.request();
      let responseBody = null;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text().catch(() => '');
      }
      let postData = null;
      try {
        postData = request.postDataJSON();
      } catch {
        postData = request.postData();
      }
      captures.push({
        capturedAt: new Date().toISOString(),
        method: request.method(),
        url,
        status: response.status(),
        requestHeaders: await request.allHeaders().catch(() => request.headers()),
        postData,
        response: responseBody,
      });
      console.log(`Captured ${request.method()} ${url} -> ${response.status()}`);
    });

    await page.goto(cfg.pddUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await closeBlockingModals(page).catch(() => {});
    console.log(`Probe is listening for ${Math.round(cfg.probeMs / 1000)}s. Finish login and click the business flows you want to capture.`);
    await page.waitForTimeout(cfg.probeMs);
    const storagePath = await savePddStorageState(context, cfg.storageStatePath);
    await writeJsonSnapshot(cfg.outputJson, {
      capturedAt: new Date().toISOString(),
      pddUrl: page.url(),
      storageStatePath: storagePath,
      captures,
    });
    console.log(`Saved ${captures.length} PDD API captures to ${cfg.outputJson}.`);
    console.log(`Saved storageState to ${storagePath}.`);
  } finally {
    await closePddBrowserContext(browser, context);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
