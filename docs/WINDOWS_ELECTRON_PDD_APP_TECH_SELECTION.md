# Windows Electron PDD App 技术选型方案

本文档按第一性原理重新定义 Windows 常驻采集 App 的技术方案：先做能稳定完成业务闭环的最小系统，只在真实运行问题出现后加入对应的工程环节。

关联手册：

- [PDD Real Chrome CDP Collection Manual](./PDD_REAL_CHROME_CDP_COLLECTION.md)

## 1. 第一性原理

这个 App 只需要解决 5 个本质问题：

1. 能拿到 PDD 商家后台登录态下的订货管理数据。
2. 客户不需要懂 Chrome 参数、CDP 端口、命令行或脚本。
3. Windows 电脑常开时，采集逻辑能自己按时运行。
4. PDD 掉线、验证、采集失败时，能把人叫回来处理。
5. 本地能留下足够的数据和日志，判断上一次采集是否成功。

由此得到必要结论：

- PDD `pageQueryDetail` 需要页面环境生成动态 `anti-content`，不能做纯 Node HTTP + cookie 直连。
- 必须保留真实 Chrome 页面环境，但 CDP 端口必须由 App 内部管理，不能让客户配置 `9222`。
- 采集主链路应监听或触发页面内真实业务接口 `POST /cartman-mms/orderManagement/pageQueryDetail`。
- DOM 表格解析不是主链路，只能作为失败时的诊断信息。
- 验证码、滑块、扫码不能自动绕过，只能告警并让用户人工登录。

## 2. 当前范围

首版必须包含：

- Windows Electron 安装包。
- App 管理的真实 Chrome 进程、独立 PDD profile、内部随机 CDP 端口。
- 一个本地后端服务，负责调度、采集、告警、持久化。
- 一个前端控制台，负责状态展示、登录入口、手动同步、告警配置。
- 页面内 `pageQueryDetail` 响应采集。
- SQLite 本地存储最近采集结果、运行记录、配置和告警记录。
- 至少一个可用的 IM 告警 adapter。

首版不做：

- 不做纯服务器部署或纯 headless 方案。
- 不做纯 HTTP 调 PDD 业务接口。
- 不把 DOM scraping 作为采集主链路。
- 不做多店铺、多账号、多机器同步。
- 不做自动破解验证码、滑块、扫码。
- 不先做自动更新、诊断包、复杂进程编排、Windows Service、全量 adapter 矩阵。

## 3. 最小架构

```text
Electron App
  ├─ Main Process
  │  ├─ single instance
  │  ├─ tray / window
  │  ├─ start backend
  │  └─ start/open Chrome
  ├─ Renderer
  │  ├─ status dashboard
  │  ├─ login actions
  │  ├─ sync history
  │  └─ alert settings
  ├─ Local Backend
  │  ├─ scheduler
  │  ├─ PDD collector
  │  ├─ alert adapter
  │  ├─ SQLite
  │  └─ logs
  └─ App-managed Chrome
     ├─ independent profile
     ├─ internal CDP port on 127.0.0.1
     └─ PDD order-management page
```

职责边界：

- Electron main 只负责桌面生命周期：启动、托盘、窗口、打开 Chrome、启动本地后端。
- Renderer 只做 UI，不承担定时任务。
- Backend 承担所有业务逻辑：调度、采集、告警、持久化。
- Chrome 只作为 PDD 登录态和页面请求环境。

## 4. 技术选型

| 问题 | 首版选型 | 原因 | 暂不加入 |
| --- | --- | --- | --- |
| 桌面安装和常驻 | Electron + electron-builder NSIS | Windows 安装包、托盘、开机启动成熟 | Tauri、原生 C# 重写 |
| 前端控制台 | Vite + React + TypeScript | 足够做状态页和配置页 | SSR、复杂路由、远程管理后台 |
| 本地后端 | Node.js + TypeScript + Fastify | 和现有 Playwright/脚本生态一致，打包简单 | 微服务、队列系统、独立 Windows Service |
| PDD 采集 | Playwright `connectOverCDP` + 真实 Chrome | 已验证能复用页面 `anti-content` | 逆向 `anti-content`、纯 HTTP 客户端 |
| 浏览器 | 优先使用系统 Google Chrome Stable | 最接近真实用户环境，降低风控变量 | 首版内置 Chromium/Chrome |
| 本地存储 | SQLite + better-sqlite3 | 单机、可查询、比 JSON 更抗异常退出 | PostgreSQL、远程数据库 |
| 日志 | pino 写本地文件 | 够排查采集和告警问题 | 日志平台、复杂压缩归档 |
| 密钥 | Electron `safeStorage` | 保存 webhook/app secret 不明文落盘 | 一开始接 Windows Credential Manager |
| 告警 | `AlertAdapter` 接口 + 当前客户实际使用的一个 adapter | 保持可扩展，但不一次实现四套 | 全量飞书/企微官方接口矩阵 |

## 5. Chrome 管理

客户不能配置端口。App 自己完成：

```text
1. 查找系统 Google Chrome Stable
2. 分配 127.0.0.1 上的随机可用端口
3. 使用独立 profile 启动 Chrome
4. 打开 PDD 订货管理页
5. Backend 通过内部 CDP URL 连接 Chrome
```

profile 路径：

```text
%APPDATA%\Mao\PDDChromeProfile
```

启动形态：

```powershell
chrome.exe `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port="<APP_INTERNAL_PORT>" `
  --user-data-dir="%APPDATA%\Mao\PDDChromeProfile" `
  --no-first-run `
  --no-default-browser-check `
  "https://mc.pinduoduo.com/ddmc-mms/order/management"
```

用户体验：

- 用户只看到“打开登录窗口”。
- 登录后 Chrome 可以最小化，但不要关闭。
- UI 不展示 `9222`、CDP、profile、启动参数。
- 如果系统没有 Chrome，首版先提示安装 Google Chrome Stable。
- 只有当大量客户没有 Chrome 或安装 Chrome 成本不可接受时，再考虑内置浏览器运行时。

## 6. PDD 采集链路

主链路只走页面内业务接口：

```text
Backend
  -> start/open app-managed Chrome
  -> connectOverCDP(127.0.0.1:<APP_INTERNAL_PORT>)
  -> find or open order-management page
  -> check login state
  -> attach response listener for pageQueryDetail
  -> trigger page query
  -> parse result.total and result.resultList
  -> write SQLite
  -> update last success state
```

真实接口：

```text
POST https://mc.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail
```

实现要求：

- 优先监听真实页面发出的 `pageQueryDetail` response。
- 如果需要主动触发查询，应通过页面已有操作或页面上下文发起，不能用 Node 侧裸 HTTP 直连。
- 采集结果以接口返回的 `total` 和 `resultList` 为准。
- 每次采集保存原始响应摘要，便于排查字段变化。
- DOM 只用于失败诊断，例如截图、当前 URL、页面标题、登录提示文案。

失败分类：

| 现象 | 判断 | 首版动作 |
| --- | --- | --- |
| 页面跳登录 | 登录态失效 | 发告警，提示用户打开登录窗口 |
| 出现滑块/扫码/验证码 | 需要人工验证 | 发告警，保留 Chrome 窗口 |
| `43001` 或会话过期文案 | session 失效 | 发告警，等待重新登录 |
| `54001` | 请求没有正确页面风控头 | 标记采集实现错误，不继续重试刷接口 |
| 长时间没有 `pageQueryDetail` 响应 | 页面未触发查询或前端变更 | 截图和记录 DOM 诊断 |
| `resultList.length` 与 `total` 不一致 | 分页或字段解析问题 | 标记数据不完整，不覆盖上次成功数据 |

## 7. 本地后端 API

首版只保留 UI 需要的接口：

```text
GET  /health
GET  /status
POST /pdd/open
POST /pdd/sync-now
GET  /sync/history
GET  /alerts/history
POST /alerts/test
GET  /settings
PUT  /settings
GET  /logs/recent
```

暂不做：

- 远程访问 API。
- 多用户权限系统。
- OpenAPI 文档站点。
- 复杂任务队列。

## 8. SQLite 数据模型

首版只建必要表：

```text
settings
  key
  value
  encrypted
  updated_at

sync_runs
  id
  started_at
  finished_at
  status
  target_date
  row_count
  expected_total
  error_code
  error_message

pdd_order_rows
  id
  sync_run_id
  target_date
  source_order_id
  payload_json
  created_at

alerts
  id
  created_at
  adapter
  severity
  title
  dedupe_key
  status
  error_message
```

说明：

- `settings` 保存普通配置，secret 字段用 `safeStorage` 加密。
- `sync_runs` 是判断系统是否健康的核心表。
- `pdd_order_rows` 先保存接口 payload，字段稳定后再拆业务列。
- `alerts` 同时承担发送历史和简单去重依据。
- 不先建复杂 health snapshot、job lock、diagnostic tables；如果运行中确实需要再加。

## 9. 告警 Adapter

首版必须有 adapter 接口，但不一次实现所有平台。

```ts
export interface AlertAdapter {
  id: string;
  send(alert: AlertPayload): Promise<AlertResult>;
}

export interface AlertPayload {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  markdown: string;
  dedupeKey: string;
  occurredAt: string;
  source: 'pdd' | 'chrome' | 'backend';
}
```

首版实现顺序：

1. 先实现当前客户实际使用的一个 adapter。
2. 如果只需要群通知，优先 webhook，配置最少。
3. 如果需要发给指定成员、部门、机器人权限审计，再接官方应用消息。
4. 第二个平台不要预先实现，等真实客户需要时按同一接口补。

官方文档入口：

- 飞书发送消息：`https://open.feishu.cn/document/server-docs/im-v1/message/create`
- 飞书自定义机器人：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot`
- 企业微信发送应用消息：`https://developer.work.weixin.qq.com/document/path/90236`
- 企业微信群机器人：`https://developer.work.weixin.qq.com/document/path/91770`

首版必须告警：

- PDD 需要重新登录。
- PDD 出现滑块、扫码、验证码、人机验证。
- 连续采集失败达到阈值。
- 最近一次成功采集超过阈值。
- `pageQueryDetail` 返回会话过期或 `54001`。
- Chrome 无法连接并且自动重开失败。

首版去重规则：

- 同一个 `dedupeKey` 30 分钟内只发一次。
- 恢复成功时发一次恢复通知。
- 只有发生告警风暴时，再加更复杂的告警状态机。

## 10. 调度和运行

首版调度保持简单：

```text
Backend starts
  -> load settings
  -> ensure Chrome
  -> check PDD status
  -> run sync on interval
  -> write sync_runs
  -> send alert on failure
```

必要规则：

- 同一时间只允许一个采集任务运行。
- 每次采集必须有超时。
- App 启动后先做一次状态检查，不立即刷接口。
- 掉登录时停止自动采集，只保留健康检查和告警。
- 最近一次成功数据不被失败结果覆盖。

暂不加入：

- 分布式锁。
- 队列系统。
- 复杂补偿任务。
- 定时重启 Chrome。
- Windows Service。

这些只有在出现重复进程、任务重入、长期内存增长、用户退出 session 等真实问题后再加。

## 11. 前端页面

首版只需要 4 个页面：

- 总览：
  - PDD 登录状态。
  - Chrome 连接状态。
  - 最近一次成功采集时间。
  - 最近一次采集行数和接口总数。
  - 最近告警。
- PDD：
  - 打开登录窗口。
  - 重新打开订货管理页。
  - 手动同步。
  - 当前错误原因。
- 告警：
  - 选择 adapter。
  - 填写 webhook 或 app 配置。
  - 测试发送。
- 日志：
  - 最近运行日志。
  - 最近采集记录。
  - 最近告警记录。

不先做：

- 复杂数据看板。
- 权限系统。
- 远程控制台。
- 诊断包导出。
- 多店铺切换 UI。

## 12. 出问题再加的环节

| 真实问题 | 先观察什么 | 再加入什么 |
| --- | --- | --- |
| 客户电脑没有 Chrome | 缺失比例、安装难度 | 内置受管浏览器运行时 |
| Chrome 经常崩溃 | 崩溃频率、是否和采集有关 | Chrome watchdog、指数退避重启 |
| Backend 崩溃影响 UI | 崩溃日志、是否可恢复 | 独立 backend child process 或 Windows Service |
| 告警刷屏 | `dedupeKey`、失败频率 | 持久化告警状态机、升级策略 |
| 采集字段频繁变化 | 原始 payload diff | 字段映射版本、兼容解析层 |
| 数据量变大 | SQLite 写入耗时、文件大小 | 索引优化、归档表、导出任务 |
| 长期运行内存上涨 | 进程 RSS 曲线 | 定时重启、泄漏定位 |
| Windows 休眠导致中断 | 电源日志、用户设置 | 开机检查清单、恢复提示 |
| 用户退出 Windows session | Chrome 是否还能保持页面 | 明确要求保持登录 session，必要时再评估服务化方案 |
| 需要指定人/部门告警 | 客户权限要求 | 飞书/企微官方应用消息 adapter |

原则：没有观测到的问题不先工程化。

## 13. 开发分期

### Phase 1: 最小可用闭环

范围：

- Electron 安装包。
- 本地 Backend API。
- App 自动发现并启动 Chrome。
- App 内部分配 CDP 端口，不暴露给客户。
- 独立 PDD profile。
- 打开 PDD 登录窗口。
- 监听并解析 `pageQueryDetail`。
- SQLite 保存 `sync_runs` 和 `pdd_order_rows`。
- 一个告警 adapter。
- 基础日志页。

验收：

- 客户不需要配置 `9222` 或任何 CDP 端口。
- 用户登录 PDD 后，可以采集当天订货管理数据。
- 采集行数与 `pageQueryDetail.result.total` 可核对。
- 掉登录或出现验证时，3-5 分钟内收到告警。
- 失败采集不会覆盖上一次成功数据。
- Windows 重启后 App 能自动启动并展示当前状态。

### Phase 2: 按问题补强

触发条件和范围由 Phase 1 运行结果决定：

- 如果 Chrome 不稳定，再做 Chrome watchdog。
- 如果告警刷屏，再做持久化告警状态机。
- 如果客户要求指定人/部门，再做官方应用消息 adapter。
- 如果日志不够定位，再做诊断包导出。
- 如果数据字段变化，再做字段映射版本。

验收：

- 每个新增环节都有对应的线上问题或客户需求。
- 新增环节能被开关控制，不影响最小采集闭环。

### Phase 3: 产品化增强

只在业务闭环稳定后考虑：

- 自动更新。
- 多店铺。
- 远程运维面板。
- 数据导出模板。
- 长期日志归档。
- 安装环境自检。

## 14. 最终验收标准

首个可交付版本满足：

- Windows 可一键安装。
- 客户不需要命令行操作。
- 客户不需要配置 Chrome/CDP/端口。
- App 可打开 PDD 登录窗口。
- 登录后可采集 `pageQueryDetail` 当天数据。
- 本地可查看最近采集结果和失败原因。
- PDD 掉线、验证、采集失败会通知到配置的 IM。
- App 重启后能复用 PDD profile 登录态。

## 15. 决策记录

- 使用真实 Chrome + CDP，因为 PDD 业务接口依赖页面动态 `anti-content`。
- 不把固定 `9222` 作为配置项，端口由 App 内部分配。
- 默认采集 `pageQueryDetail` 响应，不走 DOM 表格解析。
- Electron main 不承载业务定时任务，业务逻辑放本地 backend。
- SQLite 是本地状态源，不引入远程数据库。
- 告警先做 adapter contract，再按真实客户需要实现具体平台。
- 所有复杂守护能力都必须由真实运行问题触发。
