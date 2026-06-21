# Windows 微信操作录制

当 Windows 微信自动化没有调通时，不要先猜 UI 结构。让用户在 Windows 电脑上手动做一遍标准动作，录制器会记录：

- 鼠标点击坐标。
- 控制键和快捷键，例如 `Ctrl+F`、`Ctrl+V`、`Enter`。
- 前台窗口进程和标题变化。
- 关键事件截图。
- `events.jsonl`、`manifest.json` 和 zip 包。

默认不会记录普通字符输入内容。截图仍可能包含微信聊天内容，所以务必使用测试群，避免打开敏感会话。

## 录制步骤

在 Windows 项目目录里运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 120 -CaseId "wechat-send-test"
```

命令启动后，在 120 秒内手动完成一次完整流程：

1. 打开或切到桌面微信。
2. 搜索目标测试群。
3. 确认进入的是正确群。
4. 粘贴提醒文案。
5. 发送或停在发送前，根据当次测试目标决定。

尽量让录制自然结束，不要用 `Ctrl+C` 中断。同一个 `CaseId` 再录一次会默认覆盖旧目录，避免多次操作混在一个 `events.jsonl` 里；只有明确要追加到同一个 case 时才加 `-Append`。

录制结束后会生成：

```text
data/wechat-operation-recordings/wechat-send-test/
data/wechat-operation-recordings/wechat-send-test.zip
```

把 zip 包发回来即可分析。

## 推荐录三次

1. `open-room-only`：只录打开微信和搜索目标群，不发消息。
2. `draft-only`：录搜索群、粘贴文案，停在发送前。
3. `send-test-group`：只在测试群里录一次真实发送。

示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "open-room-only"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "draft-only"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -DurationSeconds 90 -CaseId "send-test-group"
```

## 可选参数

不保存截图，只记录事件：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -NoScreenshots -DurationSeconds 120
```

记录普通字符键名。只有测试账号、测试群、无敏感输入时才使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -IncludeCharacterKeys -DurationSeconds 120
```

追加到已有 case。通常不需要，排查混合流程时才使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\record-wechat-operation.ps1 -Append -CaseId "wechat-send-test" -DurationSeconds 120
```

## 如何用录制结果修自动化

优先看这几类问题：

- 搜索框点击坐标是否落错。
- 搜索后第一条结果是否就是目标群。
- 进入聊天后窗口标题或头部文本是否能确认群名。
- 输入框点击坐标是否可靠。
- `Enter` 是否发送，还是换行。
- 微信是否被其他窗口抢焦点。

修复时只把确定性路径写进 Windows helper，不把录制轨迹直接回放到生产群。
