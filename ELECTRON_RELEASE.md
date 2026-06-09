# 多多数字管家桌面版

桌面版由 Electron、本地 Node 服务和可独立更新的业务运行时组成。用户数据保存在系统用户目录，不会随安装包升级或热更新被覆盖。

## 首次配置

1. 在 `desktop/package.json` 的 `mao.updateFeedUrl` 填写公开更新地址，例如：

   ```json
   "mao": {
     "updateFeedUrl": "https://updates.example.com/duoduo/latest.json"
   }
   ```

2. 安装依赖并打包：

   ```bash
   pnpm install
   pnpm package:mac
   pnpm package:win
   ```

   macOS 安装包必须在 macOS 构建；Windows 安装包应在 Windows 或 GitHub Actions 构建。产物位于 `release/`。

3. 首次启动后，在“启动检查”窗口点击“配置服务”，填写飞书凭证、表格目标和 Chrome 服务地址。配置会写入用户数据目录的 `workspace/.env`。

启动时 App 会显示阻塞式前置检查窗口，逐项验证：

- PDD Chrome 调试服务 `http://127.0.0.1:9222`
- 微信 Chrome 调试服务 `http://127.0.0.1:9333`
- 飞书 App ID / App Secret 能否完成在线鉴权
- 飞书 Wiki 或 Spreadsheet 目标是否已配置

Chrome 未启动时可直接在检查窗口启动对应的独立 Chrome。保存服务配置后会自动重新检查，不需要重启 App。

Chrome 地址在配置弹窗中可直接选择。本机标准配置为：

- PDD：`http://127.0.0.1:9222`
- 微信：`http://127.0.0.1:9333`

启动时会先检查这两个默认端口；若默认端口不可用，App 会自动切换到附近可用端口并回写配置。

只有 Chrome 运行在另一台电脑时才需要输入自定义地址，并且远程电脑必须允许当前电脑访问其调试端口。

## 24 小时在线电脑

建议关闭系统自动睡眠，并让应用保持运行。应用启动时会自动恢复已启用的定时任务。

PDD 推荐使用已安装的 Chrome：

```env
PDD_BROWSER_CHANNEL=chrome
PDD_CDP_URL=http://127.0.0.1:9222
```

微信客服号使用独立 Chrome 调试端口：

```env
WECHATY_CDP_URL=http://127.0.0.1:9333
```

macOS 启动示例：

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.duoduo/pdd-chrome"
open -na "Google Chrome" --args --remote-debugging-port=9333 --user-data-dir="$HOME/.duoduo/wechat-chrome"
```

Windows 可分别用两个快捷方式启动 Chrome，并添加：

```text
--remote-debugging-port=9222 --user-data-dir=C:\duoduo\pdd-chrome
--remote-debugging-port=9333 --user-data-dir=C:\duoduo\wechat-chrome
```

## 飞书权限

飞书自建应用至少需要 Sheets 读写、群列表/成员读取、机器人发消息和图片资源上传权限。修改权限后必须发布新版本，并由企业管理员重新授权。把 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和目标表格配置写入 `workspace/.env`。

微信客服号需要能登录网页版微信，并已加入目标群。群名和需要 @ 的成员在应用“微信群规则配置”中填写。

## 热更新

业务代码改动使用运行时热更新，不需要用户重新安装：

```bash
# 先提升根 package.json version
MAO_UPDATE_BASE_URL=https://updates.example.com/duoduo \
MAO_RELEASE_NOTES="修复定时上报" \
pnpm build:runtime-update
```

上传布局：

```text
latest.json
v0.1.1/manifest-duoduo-0.1.1-darwin-arm64.json
v0.1.1/runtime-duoduo-0.1.1-darwin-arm64.zip
v0.1.1/manifest-duoduo-0.1.1-win32-x64.json
v0.1.1/runtime-duoduo-0.1.1-win32-x64.zip
```

更新包会校验平台、最低桌面壳版本和每个文件的 SHA-256。新版本服务启动失败时，下次启动自动回退到安装包内置版本。

Electron、原生依赖、预加载 API 或打包配置发生变化时，提升 `desktop/package.json` 版本并发布新的完整安装包；同时更新根 `package.json` 的 `mao.minShellVersion`。
