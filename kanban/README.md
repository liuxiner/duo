# Kanban 静态前端

这是独立于 Electron App 的看板前端包。它不需要 Node 服务、PM2 或飞书凭证，部署时只要把构建产物上传到静态服务器。

## 构建

```bash
cd kanban
npm run build
```

构建产物在：

```text
kanban/dist/
```

可发布压缩包在：

```text
kanban/release/
```

## 部署

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

## 数据更新

页面默认读取同目录：

```text
./kanban-data.json
```

后续由 Electron App 同步并上传新的 `kanban-data.json` 即可刷新客户看到的数据。

## 配置分享

页面右上角配置按钮支持：

- 保存到浏览器 localStorage
- 导出 `kanban-config.json`
- 导入 `kanban-config.json`

配置中的 `App Secret` 不会导出明文。
