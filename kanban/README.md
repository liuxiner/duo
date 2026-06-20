# Kanban 看板前端

这是独立于 Electron App 的看板包，支持两种部署：

- 静态模式：只上传 `dist/`，页面读取 `kanban-data.json` 或浏览器 localStorage。
- 服务模式：启动随包携带的 Node 服务，网页同源请求 `/api/kanban-data`，服务端用 Feishu App Secret 读取 sheets 并生成真实看板数据。

## 构建

```bash
cd kanban
npm run build
```

构建产物在：

```text
kanban/dist/
```

如果需要额外生成可发布压缩包，再运行：

```bash
npm run release
```

默认生成带服务的压缩包。只需要纯静态压缩包时运行：

```bash
npm run release:static
```

压缩包都在：

```text
kanban/release/
```

## 静态部署

把 `kanban/dist/` 里的文件上传到服务器目录即可：

```text
index.html
assets/*
kanban-data.json
kanban-config.example.json
```

访问：

```text
https://your-domain.example/index.html
```

## 服务部署

构建后启动本地服务：

```bash
cd kanban
npm start
```

访问：

```text
http://127.0.0.1:4173
```

服务会读取 `kanban/.env`。可以复制 `.env.example` 后填写：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_KANBAN_RAW_URL
FEISHU_KANBAN_RULES_URL
FEISHU_KANBAN_MANUAL_URL
FEISHU_KANBAN_REVIEW_URL
```

也可以在页面右上角配置里保存，服务模式下配置会写到服务端 `.env`，App Secret 不会写入浏览器 localStorage。

## 数据更新

源码目录和服务器上的 `kanban-data.json` 都可以只放一份示例数据。页面刷新时会优先读取当前浏览器的 localStorage：

```text
mao-kanban-data-v1
```

没有本地数据时，才读取同目录兜底文件：

```text
./kanban-data.json
```

同步脚本在看板页面同源上下文里写入数据即可：

```js
await window.MaoKanban.setData(payload)
```

也可以直接写 localStorage：

```js
localStorage.setItem('mao-kanban-data-v1', JSON.stringify({
  savedAt: new Date().toISOString(),
  payload
}))
```

页面会在刷新或点击“刷新”时读取这份本地数据。清空本地数据后才会回退到服务器上的 `kanban-data.json`：

```js
await window.MaoKanban.clearData()
```

手动点击页面上的“刷新”会重新请求配置里的“数据 JSON 地址”，请求成功后覆盖 `mao-kanban-data-v1`。飞书 App ID/Secret 和表链接只用于配置分享，不会在静态网页里直接调用飞书 OpenAPI。

服务模式下，“数据 JSON 地址”会自动使用：

```text
/api/kanban-data
```

此时刷新会由同源 Node 服务读取飞书 sheets，再把返回的真实 payload 写入 localStorage。

## 配置分享

页面右上角配置按钮支持：

- 保存到浏览器 localStorage
- 导出 `kanban-config.json`
- 导入 `kanban-config.json`

配置中的 `App Secret` 不会导出明文。
