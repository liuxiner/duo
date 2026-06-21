# 微信桌面端 RPA 测试方案

当前只推进路线 B：桌面端 RPA。

也就是不走微信 Web 登录，不碰 PadLocal / puppet-service token，不做协议逆向；只让一台已经正常登录微信的 Windows 电脑，被很窄的脚本控制，用来向固定微信群发送低频提醒。

## 当前结论

1. Web WeChat 登录状态不好保持，暂停。
2. PadLocal 没有可用 token 申请入口，暂停。
3. Windows 桌面微信 RPA 是当前唯一推进路线。
4. 定时节拍交给 Windows 任务计划程序，Node 只处理提醒业务，RPA 只负责发送一条消息。

## 目标

验证本机已登录桌面微信时，native helper 能稳定完成：

1. 找到或启动桌面微信。
2. 打开指定测试群。
3. 校验当前会话是目标群。
4. 聚焦输入框并粘贴提醒文案。
5. dry run 不发送，只留下草稿。
6. send 模式真实发送，并通过草稿清空校验。
7. 失败时留下日志、截图或录制包，方便人工补发和修复。

## Windows 准备

用户电脑要求：

- Windows 10/11。
- 桌面微信已安装并登录。
- 使用专用微信号，不用老板或主号。
- 电脑禁休眠，最好接电源。
- 任务计划程序必须选择“只在用户登录时运行”，不能选择后台 session。
- 目标群名唯一，先用测试群。

项目准备：

```powershell
pnpm install
pnpm desktop:prepare
```

当前通道配置：

```env
MAO_USE_DESKTOP_WECHAT=true
MAO_WECHAT_CHANNEL=desktop_wechat
# 安装路径特殊时再填，否则自动探测。
MAO_WECHAT_EXE_PATH=
```

## 操作录制

Windows 端没有调通时，先不要继续猜坐标。让用户按 [Windows 微信操作录制](WINDOWS_WECHAT_OPERATION_RECORDING.md) 录三段操作，把 zip 包发回来，再按真实轨迹修 Windows helper。

推荐录三次：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "open-room-only"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "draft-only"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "send-test-group"
```

录制包位置：

```text
data/wechat-operation-recordings/<case-id>.zip
```

## 固定 RPA 链路

Windows helper 必须按这条顺序执行，失败就停，不继续往下猜：

1. 启动或激活桌面微信窗口。
2. 点击消息页签。
3. 聚焦搜索框，粘贴目标群名。
4. 最多三次点击搜索结果；候选按 UIAutomation 文本匹配度和可见位置评分排序，不能把固定结果序号当业务逻辑。
5. 核验目标群已经打开，并且头部群名和配置群名匹配。
6. 聚焦输入框，逐个 `@` 指定成员，并确认草稿里出现对应成员名。
7. 粘贴文字，确认草稿包含正文。
8. 发送文字并确认草稿清空。
9. 如有截图，重新核验群名，粘贴截图并发送。

单窗口约束：

- 不依赖 Windows/Huawei 去禁止双开；helper 自己先枚举 WeChat/Weixin 顶层窗口。
- 已有微信进程或窗口时，绝不再启动新的微信。
- 发现多个可见微信主窗口时默认直接失败并打印日志，先人工关掉多余窗口再重跑。
- 只有临时诊断时才设置 `MAO_ALLOW_MULTIPLE_WECHAT_WINDOWS=true` 放开这个限制。

## Windows 测试阶梯

以下命令都在 Windows 用户电脑上跑。

快速按当前测试群跑完整 dry-run：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "fp" -Mentions "得閑斂金" -Text "微信RPA dry-run 测试" -PrintLogs
```

确认草稿、群名、@ 人都没问题后，再只在测试群真实发送：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "fp" -Mentions "得閑斂金" -Text "微信RPA send 测试" -Send -PrintLogs
```

1. 权限和 helper 基础检查：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\native\windows\wechat-automation.ps1 --check-permission
```

2. 只验证能打开并定位目标群：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "测试群名" -OpenOnly
```

3. 验证粘贴和草稿读取，不发送：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "测试群名" -KeyboardOnly
```

4. 验证 Enter 是否会发送。只在测试群跑：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "测试群名" -KeyboardEnter
```

如果这一步失败，检查微信设置里发送快捷键是不是 `Ctrl+Enter`。

5. 当前输入框已有草稿时，只测试按一次 Enter。只在测试群跑：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -PressReturnOnly
```

6. dry run 写入草稿，不发送：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 `
  -Room "测试群名" `
  -Mentions "成员昵称" `
  -Text "桌面微信 dry run，请忽略"
```

7. 真实发送。只在测试群跑：

```powershell
$env:MAO_APP_ROOT="$PWD\dist\runtime"
$env:MAO_WORKSPACE_PATH="$PWD"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 `
  -Room "测试群名" `
  -Mentions "成员昵称" `
  -Text "桌面微信 send smoke，请忽略" `
  -Send
```

日志位置：

```text
logs/wechat-desktop-automation-YYYY-MM-DD.log
```

## 稳定性判定

连续跑 10 次打开群测试：

```powershell
1..10 | ForEach-Object {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-wechat-rpa.ps1 -Room "测试群名" -OpenOnly
  Start-Sleep -Seconds 2
}
```

- 10/10 通过：可以进入业务 dry run。
- 8-9/10 通过：先固定微信窗口尺寸和位置，再重测。
- 低于 8/10：先录制操作轨迹，不进入真实发送。

连续跑 5 次真实发送：

- 5/5 通过：可接入低频定时提醒。
- 任意一次发错群、输入框未聚焦、草稿校验失败：停止自动发送，只保留 dry run 和人工补发。

## 定时运行形态

最终形态：

```text
Windows Task Scheduler
  每 1 分钟启动一次 Node 脚本
    -> 查 due reminders
    -> 加锁防重复
    -> 调用桌面微信 RPA helper
    -> 写发送结果/截图/日志
    -> 失败通知管理员人工补发
```

关键规则：

- 任务计划程序选择“只在用户登录时运行”。
- 如果任务已在运行，不启动新实例。
- Node 负责任务、模板、幂等、日志、失败重试。
- PowerShell helper 负责微信窗口操作。
- 每条提醒必须有唯一 ID，避免重复发送。
- 失败最多重试 1 次，之后通知管理员。

## 非目标

- 不继续绕 Web WeChat 安全提示。
- 不使用 PadLocal / Puppet Service token。
- 不做高频群发或营销群发。
- 不让 RPA 在未通过测试群验证前发送生产群。
- 不把录制轨迹直接回放到生产群。
