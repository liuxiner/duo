# 多多飞书实时看板

这个项目把多多买菜订货数据同步到飞书 Sheet，并提供本地 Web UI 查看实时看板。

## 快速启动

第一次使用先安装依赖：

```bash
pnpm install
```

准备 `.env`：

```bash
cp .env.example .env
```

至少填写这些配置：

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_KANBAN_RAW_URL=https://xcn413dmlc7m.feishu.cn/wiki/EChawQEHEipllvkxqMycZL3Yn7c
FEISHU_KANBAN_RULES_URL=https://xcn413dmlc7m.feishu.cn/wiki/VY6Pw5l9piRdzIk3mQ4c5icrnib
FEISHU_KANBAN_REVIEW_URL=https://xcn413dmlc7m.feishu.cn/wiki/H4QTwsAcJiUzZ5kaHr9cMJHpnCc
FEISHU_KANBAN_WRITEBACK=true
```

启动本地 Web 服务：

```bash
pnpm run web
```

打开实时看板：

```text
http://127.0.0.1:4173/kanban.html
```

如果 `4173` 端口被占用，可以换端口：

```bash
PORT=4174 pnpm run web
```

对应打开：

```text
http://127.0.0.1:4174/kanban.html
```

## 看板数据

- Raw data source: `FEISHU_KANBAN_RAW_URL`
- Kanban rules: `FEISHU_KANBAN_RULES_URL`
- API: `http://127.0.0.1:4173/api/kanban-data`
- 强制刷新 API 缓存：`http://127.0.0.1:4173/api/kanban-data?refresh=1`
- Review writeback: `FEISHU_KANBAN_REVIEW_URL`

看板页面里的 `飞书表配置` 可以直接修改 raw 数据源、规则表和复盘表 URL。点击 `保存配置` 后会写入 `.env`，并立即重新读取和写回复盘。

看板会按日期拆分数据：

- `days[date].kanban.big`: 大看板，按仓库聚合展示。
- `days[date].kanban.small`: 小看板，按 SKUID 展示。

页面顶部是分仓库大看板，底部是分 SKUID 小看板，不包含折线图和 TOP10。

大看板不单独展示 `技术服务费`，会展示 `总仓储费用`：

```text
总仓储费用 = 技术服务费 + 多货费 + 云仓费用 + 共享仓费用 + 其他仓储费
```

当 `FEISHU_KANBAN_WRITEBACK=true` 时，服务会把看板复盘数据写回 `FEISHU_KANBAN_REVIEW_URL`。每个日期会创建或覆盖一个 worksheet：

```text
看板复盘-YYYY-MM-DD
```

每个日期复盘 sheet 里包含两个区块：`大看板（分仓库）` 和 `小看板（分SKUID）`。

每次写回复盘表后，服务都会把日期型 worksheet 自动按时间降序排列，最新日期在最前面，方便查表。

## 同步飞书数据

如果需要先从多多买菜后台采集并写入飞书：

```bash
pnpm run sync:pdd
```

指定日期范围同步：

```bash
PDD_DATE_FROM=2026-06-01 PDD_DATE_TO=2026-06-18 PDD_SELECT_YESTERDAY=false pnpm run sync:pdd
```

更多 PDD 登录、Chrome 调试端口、定时同步和群上报说明见 [PDD_FEISHU_SYNC.md](PDD_FEISHU_SYNC.md)。

## 常见问题

如果看板提示飞书读取失败，检查：

- `.env` 里的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 是否正确。
- 飞书自建应用是否有读取 Sheets/Wiki 的权限，并已发布和授权。
- `FEISHU_KANBAN_RAW_URL` 和 `FEISHU_KANBAN_RULES_URL` 是否是当前要读取的飞书 Wiki/Sheet。

如果页面打开但没有数据，先访问：

```text
http://127.0.0.1:4173/api/kanban-data?refresh=1
```

看返回里的 `source.rawRowCount`、`source.bigBoardFieldCount` 和 `source.smallBoardFieldCount` 是否大于 0。
