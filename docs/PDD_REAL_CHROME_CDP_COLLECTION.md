# PDD Real Chrome CDP Collection Manual

本文档沉淀拼多多商家后台订货管理数据采集的验证结论和部署要求。结论基于 2026-06-22 对 `https://mc.pinduoduo.com/ddmc-mms/order/management` 的真实 Chrome/CDP 登录、采集和 1 小时监听。

## 1. 结论

推荐形态：

```text
真实 Chrome 登录 + 持久 profile + CDP 连接 + 订货管理页内接口采集
```

不推荐形态：

```text
纯 Node HTTP + cookie + 直接 POST 业务接口
```

原因：

- 订货管理真实数据接口是 `POST /cartman-mms/orderManagement/pageQueryDetail`。
- 该接口返回的是业务 JSON，比 DOM 逐行解析更可靠。
- 但接口请求必须携带页面动态生成的 `anti-content` 风控头。
- 只拿 cookie 在 Node 里直接 POST 该接口会被拦截，实测返回 `errorCode=54001`。
- 登录后不需要人工继续操作页面，但仍需要 Chrome 进程和页面环境存在，用来维持登录态并生成风控请求头。

## 2. 已验证结果

验证时间：

- 开始：2026-06-22 15:29:38 Asia/Shanghai
- 结束：2026-06-22 16:29:43 Asia/Shanghai

验证结果：

- 真实 Chrome CDP 登录成功后，订货管理页保持登录 1 小时。
- 页面始终停留在 `https://mc.pinduoduo.com/ddmc-mms/order/management`。
- 页面表格始终存在，未跳回登录页。
- 未出现 `43001 会话已过期`。
- 真实业务接口 `POST /cartman-mms/orderManagement/pageQueryDetail` 返回 `total=73`，`sessionEnd=false`。
- 现有 DOM 同步链路也成功采集 `73 / 73` 条并写入本地文件。

本次验证产物：

```text
data/latest.json
data/latest.csv
data/pdd/pdd-orders-raw-2026-06-22-15-31-36.csv
data/pdd-cdp-monitor/summary-2026-06-22T07-29-37-698Z.json
data/pdd-cdp-monitor/monitor-2026-06-22T07-29-37-698Z.jsonl
data/pdd-cdp-monitor/page-query-detail-capture-2026-06-22T08-15-28-560Z.json
```

## 3. 运行环境要求

服务器需要具备：

- Node.js 和项目依赖。
- Google Chrome 或 Chromium。
- 可长期运行的 Chrome profile 目录。
- CDP 调试端口，仅绑定本机 `127.0.0.1`。
- 首次登录时可人工操作浏览器的能力，例如 VNC、远程桌面、Xvfb + noVNC，或临时本机图形环境。

安全要求：

- 不要把 CDP 端口暴露到公网。
- 不要把 Chrome profile、`data/pdd-storage-state.json`、cookie、`anti-content` 日志提交到仓库。
- 服务器只允许可信用户访问 Chrome 调试端口。
- 生产部署建议用单独系统用户运行 Chrome 和采集脚本。

## 4. Chrome 启动方式

macOS 示例：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.cache/pdd-real-chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  "https://mc.pinduoduo.com/ddmc-mms/order/management"
```

Linux 服务器示例：

```bash
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/opt/mao/current/.cache/pdd-real-chrome-profile \
  --no-first-run \
  --no-default-browser-check \
  "https://mc.pinduoduo.com/ddmc-mms/order/management"
```

无桌面服务器首次登录时，可以用 VNC/noVNC 进入浏览器完成滑块、扫码或短信验证。登录完成后，Chrome 可以继续在后台运行。

## 5. 登录流程

1. 启动真实 Chrome，并打开订货管理页。
2. 如果跳转到登录页，先完成滑块拼图。
3. 页面出现二维码后，用拼多多商家版 App 扫码登录。
4. 登录成功后确认进入 `商家后台`，URL 为：

   ```text
   https://mc.pinduoduo.com/ddmc-mms/order/management
   ```

5. 确认订货管理表格出现。
6. 保持 Chrome 进程和 profile 不被清理。

本次验证中，未登录状态会先出现滑块拼图；通过后才显示扫码二维码。二维码截图不能替代滑块验证。

## 6. 采集方式

当前项目可直接复用 CDP 登录态跑现有 DOM 同步：

```bash
PDD_CDP_URL=http://127.0.0.1:9222 \
PDD_SYNC_MODE=dom \
PDD_SELECT_YESTERDAY=false \
PDD_AUTO_WAIT_FOR_LOGIN=true \
PDD_LOGIN_WAIT_MS=60000 \
pnpm run sync:pdd
```

验证输出示例：

```text
PDD table detected. Continuing sync.
Date range already set to 2026-06-22 ~ 2026-06-22.
Page size set to 100.
Query stabilized: 73 visible rows, 73 total.
Collected page 1: 73 rows.
Validated collected rows: 73 / 73.
Wrote 73 calculated rows to data/latest.csv
Wrote JSON to data/latest.json
```

后续如果要降低 DOM 依赖，推荐实现“页面内接口采集”：

1. CDP 连接真实 Chrome。
2. 打开或复用订货管理页。
3. 等待页面初始化完成。
4. 捕获或触发 `POST /cartman-mms/orderManagement/pageQueryDetail`。
5. 从响应 JSON 的 `result.total` 和 `result.resultList` 生成内部数据。

## 7. 真实业务接口

接口：

```text
POST https://mc.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail
```

本次捕获到的请求体形态：

```json
{
  "page": 1,
  "pageSize": 100,
  "areaId": 31,
  "warehouseIds": [3915, 10925, 19225, 5786, 19231, 8686, 19233, 19211, 19212, 19232],
  "startSessionTime": 1782113493214,
  "endSessionTime": 1782113493214
}
```

字段说明：

- `page` / `pageSize`：分页参数。
- `areaId`：销售区域，本次为浙江区域 `31`。
- `warehouseIds`：页面当前区域下的仓库 ID 列表。
- `startSessionTime` / `endSessionTime`：页面初始化得到的会话时间。该值不是固定配置，应从页面请求或页面状态获得。

成功响应关键字段：

```json
{
  "success": true,
  "errorCode": 1000000,
  "result": {
    "total": 73,
    "updateTime": {
      "sessionEnd": false
    },
    "resultList": []
  }
}
```

## 8. 不能纯 HTTP 直连的原因

真实 `pageQueryDetail` 请求头包含：

```text
anti-content: <long dynamic value>
origin: https://mc.pinduoduo.com
referer: https://mc.pinduoduo.com/ddmc-mms/order/management
cookie: <browser cookies>
```

`anti-content` 是页面环境动态生成的风控头。缺少它时，即使 cookie 存在，直接请求也会失败：

```json
{
  "errorCode": 54001
}
```

因此，数据采集应依赖真实 Chrome 页面环境，而不是只保存 cookie 后用后端直接 POST。

可行方式：

- 在页面内触发接口，让浏览器自动带上 `anti-content`。
- 通过 Playwright/CDP 监听 `response`，读取 `pageQueryDetail` JSON。
- 或在页面上下文里调用页面已有请求能力，但要避免复制/硬编码风控生成逻辑。

不建议：

- 尝试长期保存某次 `anti-content`。
- 在 Node 侧复刻 PDD 风控脚本。
- 关闭 Chrome 后只靠 storageState/cookie 请求业务接口。

## 9. Token 和 Cookie 观察

本次 1 小时监听看到的关键 cookie：

- `PASS_ID`：主登录态 cookie，1 小时内未变化。
- `windows_app_shop_token_23`：1 小时内未变化。
- `_nano_fp`：设备/指纹相关 cookie，1 小时内未变化。
- `_a42` / `_bee` / `_f77` / `rckk` / `ru1k` / `ru2k`：风控相关 cookie，过期时间在页面活动中被延展。

本次观察到的 token 接口：

```text
POST https://mc.pinduoduo.com/janus/api/subSystem/getAuthToken
```

请求体：

```json
{
  "subSystemId": 16
}
```

该接口返回 `authToken`，页面将其用于 Titan/WebSocket/消息子系统。它不是订货管理主登录态刷新接口，也不能替代 `anti-content`。

未观察到独立的“官方刷新主登录 token”接口。主会话稳定性主要依赖 Chrome profile、cookie 和页面活跃状态。

## 10. 监控建议

生产监控应至少检查：

- Chrome CDP 端口是否可访问：

  ```bash
  curl -sS http://127.0.0.1:9222/json/version
  ```

- PDD 页面是否仍在订货管理页。
- 页面是否出现登录/验证关键词：

  ```text
  请登录 / 账号登录 / 扫码登录 / 验证码 / 安全验证 / 人机验证 / 滑块 / 拼图 / 会话已过期
  ```

- `pageQueryDetail` 是否返回：

  ```text
  success=true
  errorCode=1000000
  result.total >= 0
  result.updateTime.sessionEnd=false
  ```

- 本地输出是否产生并包含期望日期：

  ```text
  data/latest.json
  data/latest.csv
  ```

异常处理：

- 如果页面跳登录：通知人工重新扫码。
- 如果接口返回 `54001`：优先检查是否绕过了页面环境，或 `anti-content` 未携带。
- 如果接口返回 `43001`：登录态过期，需要重新登录。
- 如果页面表格存在但接口为 0：确认接口是否选错；订货管理应使用 `pageQueryDetail`，不是 `queryAppointmentGoodsList`。

## 11. 部署建议

推荐部署结构：

1. PM2/systemd 管理 Chrome 进程。
2. Chrome 使用固定 profile：

   ```text
   .cache/pdd-real-chrome-profile
   ```

3. 采集任务通过 `PDD_CDP_URL=http://127.0.0.1:9222` 连接 Chrome。
4. 首次部署或登录失效时，运维人员通过 VNC/noVNC 完成登录。
5. 定时任务跑采集脚本并写本地/飞书。
6. 监控任务检查 CDP、页面状态和 `pageQueryDetail`。

环境变量建议：

```env
PDD_CDP_URL=http://127.0.0.1:9222
PDD_SYNC_MODE=dom
PDD_SELECT_YESTERDAY=true
PDD_AUTO_WAIT_FOR_LOGIN=true
PDD_LOGIN_WAIT_MS=180000
PDD_BROWSER_PROFILE_DIR=.cache/pdd-real-chrome-profile
```

如果后续实现页面内接口采集，可以新增独立模式，例如：

```env
PDD_SYNC_MODE=page-api
```

该模式应复用真实 Chrome 页面，而不是纯 HTTP 请求。

## 12. 开发边界

短期可做：

- 继续使用现有 DOM 同步，依赖真实 Chrome/CDP 提高登录成功率。
- 增加 `pageQueryDetail` 响应捕获，减少 DOM 解析依赖。
- 增加登录态监控和过期通知。
- 保存最近一次成功请求体中的 `areaId`、`warehouseIds` 和 `sessionTime` 作为诊断信息。

短期不要做：

- 不要把 `anti-content` 当作固定配置。
- 不要把 CDP 端口开放到公网。
- 不要把账号密码写入代码或文档。
- 不要以 `queryAppointmentGoodsList` 作为订货管理页面数据源。

验收标准：

- 登录完成后，采集任务能在无人工点击的情况下产出 `data/latest.json`。
- `data/latest.json.salesDate` 为目标日期。
- `data/latest.json.expectedTotal` 与页面 `共有 N 条` 一致。
- `rows.length` 与 `expectedTotal` 一致。
- 连续 1 小时监控无登录跳转和会话过期。
