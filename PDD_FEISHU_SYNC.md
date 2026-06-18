# PDD to Feishu Sync

This pipeline collects product table data from the 多多买菜商家后台, writes local CSV/JSON files, and optionally writes the same rows into a Feishu spreadsheet.

## Files

- `scripts/sync-pdd-to-feishu.mjs`: Playwright collector + Feishu writer.
- `.env.example`: required configuration template.
- `data/latest.csv`: latest collected CSV, generated at runtime.
- `data/latest.json`: latest collected JSON, generated at runtime.
- `scripts/run-daily-sync.sh`: cron/launchd entrypoint.

## First Local Setup

1. Install dependencies:

   ```bash
   pnpm install
   pnpm exec playwright install chromium
   ```

2. Create `.env` from the template:

   ```bash
   cp .env.example .env
   ```

3. Fill Feishu values in `.env`:

   ```env
   FEISHU_APP_ID=
   FEISHU_APP_SECRET=
   FEISHU_WIKI_URL=https://xcn413dmlc7m.feishu.cn/wiki/QQbkwQPd0i5e0ckqtfpcVlQynVe
   ```

4. Run the first sync locally:

   ```bash
   pnpm run sync:pdd
   ```

   A browser will open. Log in to the PDD merchant backend manually if needed, finish verification, wait for the order management table to load, then press Enter in the terminal. The login session is saved under `.cache/pdd-chrome-profile`.

   If the browser stops at a QR code, SMS, captcha, or other security verification page, complete it directly in the opened browser. The script will wait in the terminal and continue only after you press Enter.

## Start Chrome listener port
```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/pdd-debug-profile
```

## Daily 8:30 Schedule

macOS/Linux cron example:

```cron
30 8 * * * cd /Users/lx/Documents/workspace.nosync/AI/mao && /bin/bash scripts/run-daily-sync.sh >> .cache/pdd-sync.log 2>&1
```

Keep `PDD_HEADLESS=false` while testing locally. For a server, switch to `PDD_HEADLESS=true` after the profile/session is proven stable, or run with a browser-capable environment.

## Web Date Range Sync

Start the local UI:

```bash
pnpm run web
```

Then open `http://127.0.0.1:4173`, select the From/To dates, and start the sync. The range is processed one day at a time. Each date creates a new Feishu worksheet when missing, or rewrites the existing worksheet with the same date title.

If PDD requires login or security verification, finish it in the browser window opened by Playwright. Web mode waits up to five minutes and continues automatically after the data table appears.

The same range can be run without the UI:

```bash
PDD_DATE_FROM=2026-06-01 PDD_DATE_TO=2026-06-06 pnpm run sync:pdd
```

## Hourly Group Screenshot Report

The reporter opens the PDD order-management page according to the web-configured `HH:MM` schedule, filters rows by warehouse rule, uploads the screenshot, and sends one rich-text message to the configured Feishu group while mentioning one or more configured members.

```bash
pnpm run report:pdd:dry-run  # save screenshot without sending
pnpm run report:pdd:once     # send one report now
pnpm run report:pdd          # keep running and check configured times every minute
```

The Feishu app needs bot capability, permission to send messages, read group information/members, and `im:resource:upload` (or `im:resource`) for screenshot upload. It must already be a member of the target group. After adding permissions, publish a new app version and complete enterprise administrator authorization. Keep `pnpm run report:pdd` running inside the current app process to execute the hourly schedule.

Each warehouse rule can also define an independent WeChat target with `微信启用 / 微信群名 / 微信@成员`. The warehouse filter, send times, and cutoff time are shared with the Feishu rule, while group and member names are resolved separately. The web UI supports a single-row WeChat report and selected multi-warehouse WeChat report. The corresponding CLI forms are:

```bash
node scripts/report-pdd-to-feishu.mjs --once --channel=wechat --ids=1
node scripts/report-pdd-to-feishu.mjs --once --channel=wechat --ids=1,3,5
node scripts/report-pdd-to-feishu.mjs --dry-run --channel=wechat --ids=1,3,5
```

Wechaty must use a dedicated Chrome debugging profile and must not share the PDD `9222` session:

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/wechaty-debug-profile
```

Set `WECHATY_CDP_URL=http://127.0.0.1:9333`. Wechaty reuses an existing WeChat tab or blank tab in that browser and never launches or closes Chrome itself.

## Login Debugging

If PDD shows browser warnings such as `--no-sandbox`, keep this enabled:

```env
PDD_CHROMIUM_SANDBOX=true
PDD_BROWSER_CHANNEL=chrome
```

If login still gets stuck at `oneredirect` or QR verification, use CDP attach mode. Quit Chrome first, then start a dedicated Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pdd-debug-profile
```

In that Chrome window, log in to PDD and open:

```text
https://mc.pinduoduo.com/ddmc-mms/order/management
```

Then set:

```env
PDD_CDP_URL=http://127.0.0.1:9222
```

and run:

```bash
pnpm run sync:pdd
```

CDP mode lets the script attach to a browser you manually control, which is useful when the normal Playwright-launched profile is rejected by PDD login.

## Feishu Target Notes

The default configuration uses a wiki URL:

```env
FEISHU_WIKI_URL=https://xcn413dmlc7m.feishu.cn/wiki/QQbkwQPd0i5e0ckqtfpcVlQynVe
```

The sync resolves the wiki node into the real spreadsheet token through Feishu OpenAPI, then creates or reuses a worksheet named by date. The default sheet title is `YYYY-MM-DD`, controlled by:

```env
FEISHU_DAILY_SHEET_NAME_FORMAT=YYYY-MM-DD
```

If you want to bypass wiki resolution, you can still use a spreadsheet token directly. For a spreadsheet URL like:

```text
https://xxx.feishu.cn/sheets/AbCdEfGhIjKl?sheet=sheet_id
```

use:

```env
FEISHU_SPREADSHEET_TOKEN=AbCdEfGhIjKl
FEISHU_SHEET_ID=sheet_id
```

If `FEISHU_SHEET_ID` is empty, the sync creates or reuses the daily worksheet. If `FEISHU_SHEET_ID` is set, it writes to that fixed worksheet instead.

The app needs permissions for reading/writing Sheets. If Feishu returns a permission error, add the Sheets API permissions to the self-built app and re-publish/re-authorize it.

## Output Shape

The collector writes whatever table columns are visible on the PDD goods page. It also prepends:

- `采集时间`
- `销售日期`
- `页面`
- `商品名称`
- `商品ID`

For order-management syncs, the script now:

- Uses Beijing time for `采集时间`, formatted as `YYYY-MM-DD-HH-MM-SS`.
- Selects yesterday's date range by default with `PDD_SELECT_YESTERDAY=true`.
- Attempts to set the page size to `PDD_TARGET_PAGE_SIZE=100`.
- Attempts to reveal masked `商家报价` values by clicking `查看报价信息` before collecting each page.
- Collects all pages until the page total is reached.
- Validates collected raw row count against the current query's `共有 N 条`.
- Writes the calculated template to Feishu:
  `采集时间 / 销售日期 / 商品名称 / 商品ID / 仓库信息 / 仓库总库存 / 仓库预估总销售数 / 销售数(份) / 商家报价 / 实际均价`.
- Saves raw rows separately under `data/pdd/pdd-orders-raw-*.csv`.

If the PDD page changes its DOM, update the extraction and interaction functions in `scripts/sync-pdd-to-feishu.mjs`.
