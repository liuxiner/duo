# 阿里云 RockyLinux 部署 Kanban

目标结构：

- Nginx 直接服务 `dist/public/kanban.html` 和 `/assets/*`
- PM2 运行 `web/server.mjs`，只处理 `/api/*`、飞书 OpenAPI、PDD 同步等服务端逻辑
- 飞书 App ID/Secret 只保存在服务器 `.env`，不会进入前端静态包

## 1. 服务器准备

建议目录：

```bash
sudo mkdir -p /opt/mao
sudo chown -R $USER:$USER /opt/mao
cd /opt/mao
git clone <your-repo-url> current
cd current
```

首次部署：

```bash
cp deploy/env.production.example .env
vim .env
```

必须填写：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_KANBAN_RAW_URL`
- `FEISHU_KANBAN_RULES_URL`
- `FEISHU_KANBAN_MANUAL_URL`
- `FEISHU_KANBAN_REVIEW_URL`

飞书自建应用至少需要能读取 Wiki/Sheet；如果要写回复盘和自动补齐手动输入表，还需要 Sheet 写入权限。加权限后要发布新版本并完成企业管理员授权。

部署后也可以让个人用户在 `/kanban.html` 右上角配置弹窗里填写自己的飞书 `App ID / App Secret` 和表格 URL。`App Secret` 只保存到当前实例的 `.env`，不会通过配置读取接口明文回显；再次保存时 Secret 留空表示保留原值。

当前凭证存储是单实例 `.env` 模式，适合个人自用或一人一套部署。若多个用户共用同一个域名，需要先增加用户登录、会话和按用户隔离的凭证存储。

## 2. 一键部署

```bash
./scripts/deploy-aliyun-rocky.sh
```

脚本会执行：

1. 检查/安装 `nodejs`、`nginx`、`pm2`
2. `pnpm install --frozen-lockfile`
3. `pnpm run kanban:build`
4. `pnpm run kanban:auth-check`
5. `pm2 startOrReload ecosystem.config.cjs --update-env`
6. 安装并 reload Nginx 配置

默认 Nginx root 是：

```text
/opt/mao/current/dist/public
```

如果部署目录不同，修改 [deploy/nginx/mao-kanban.conf](../deploy/nginx/mao-kanban.conf) 里的 `root`。

## 3. 常用命令

只重建前端：

```bash
pnpm run kanban:build
```

只检查飞书鉴权：

```bash
pnpm run kanban:auth-check
```

真实读取 Kanban 并强制写回复盘：

```bash
pnpm run kanban:smoke
```

重启服务：

```bash
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 logs mao-kanban-api
```

检查本机服务：

```bash
curl -sS http://127.0.0.1:4173/api/health
curl -sS http://127.0.0.1:4173/api/kanban-data?refresh=1
```

## 4. Nginx 访问

浏览器打开：

```text
http://<server-ip-or-domain>/kanban.html
```

Nginx 缓存策略：

- `/kanban.html`: `no-store`，每次取最新入口
- `/assets/*`: `max-age=31536000, immutable`，文件名带 hash，可以长缓存
- `/api/*`: 反向代理到 `127.0.0.1:4173`

## 5. 性能口径

现在 Kanban 不再把 CSS/JS 全塞进一个 HTML：

- 源文件仍是 `web/kanban.html`，方便继续快速修改
- 构建产物是 `dist/public/kanban.html`
- CSS/JS 输出到 `dist/public/assets/kanban.<hash>.css/js`

服务端会优先读取构建产物；如果本地没跑 build，会自动 fallback 到 `web/kanban.html`，不影响开发。

## 6. PDD Playwright 同步

如果服务器也负责抓 PDD：

```bash
pnpm run sync:pdd
```

在 Electron/Web UI 的 `飞书数据同步` 页面点击 `开始同步` 时，链路是：

1. Playwright 抓 PDD Order Management
2. 写入 `FEISHU_KANBAN_RAW_URL`
3. 强制刷新 Kanban 数据
4. 强制写回 `FEISHU_KANBAN_REVIEW_URL`

服务器环境如果跑 PDD Playwright，建议先在有图形/浏览器能力的环境完成登录态，或配置可用的 Chrome/CDP。纯看板读取不依赖 PDD 登录。
