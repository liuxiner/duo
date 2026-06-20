param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RestArgs
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  # UIAutomation is available on normal Windows desktops. Keep the helper usable
  # in reduced runtimes and fall back to coordinate candidates.
}
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class MaoWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

$LogDir = if ($env:MAO_LOG_DIR) { $env:MAO_LOG_DIR } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DuoduoDigitalManager\logs' }
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogPath = Join-Path $LogDir ("wechat-desktop-automation-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$script:ActiveWeChatProcess = $null
$script:SW_RESTORE = 9
$script:SWP_NOSIZE = 0x0001
$script:SWP_NOMOVE = 0x0002
$script:SWP_SHOWWINDOW = 0x0040
$script:HWND_TOPMOST = [IntPtr](-1)
$script:HWND_NOTOPMOST = [IntPtr](-2)
$script:VK_MENU = 0x12
$script:KEYEVENTF_KEYUP = 0x0002

function Write-AutoLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Emit-Json {
  param([hashtable]$Payload)
  $Payload | ConvertTo-Json -Compress -Depth 8
}

function Parse-Options {
  $options = @{
    Room = ''
    Text = ''
    Mentions = New-Object System.Collections.Generic.List[string]
    Images = New-Object System.Collections.Generic.List[string]
    Send = $false
    CheckPermission = $false
    KeyboardTest = $false
    KeyboardEnterTest = $false
    OpenRetryTest = $false
    SelectMethod = 'click-first'
  }

  foreach ($arg in $RestArgs) {
    if ($arg -eq '--send') {
      $options.Send = $true
    } elseif ($arg -eq '--dry-run' -or $arg -eq '--no-send') {
      $options.Send = $false
    } elseif ($arg -eq '--check-permission') {
      $options.CheckPermission = $true
    } elseif ($arg -eq '--keyboard-test') {
      $options.KeyboardTest = $true
    } elseif ($arg -eq '--keyboard-enter-test') {
      $options.KeyboardEnterTest = $true
    } elseif ($arg -eq '--open-retry-test') {
      $options.OpenRetryTest = $true
    } elseif ($arg.StartsWith('--room=')) {
      $options.Room = $arg.Substring('--room='.Length).Trim()
    } elseif ($arg.StartsWith('--text=')) {
      $options.Text = $arg.Substring('--text='.Length)
    } elseif ($arg.StartsWith('--mention=')) {
      $name = $arg.Substring('--mention='.Length).Trim()
      if ($name) { $options.Mentions.Add($name) }
    } elseif ($arg.StartsWith('--mentions=')) {
      $names = $arg.Substring('--mentions='.Length) -split '[,\uFF0C]'
      foreach ($name in $names) {
        $trimmed = $name.Trim()
        if ($trimmed) { $options.Mentions.Add($trimmed) }
      }
    } elseif ($arg.StartsWith('--image=')) {
      $image = $arg.Substring('--image='.Length).Trim()
      if ($image) { $options.Images.Add($image) }
    } elseif ($arg.StartsWith('--images=')) {
      $images = $arg.Substring('--images='.Length) -split "`n"
      foreach ($image in $images) {
        $trimmed = $image.Trim()
        if ($trimmed) { $options.Images.Add($trimmed) }
      }
    } elseif ($arg.StartsWith('--select-method=')) {
      $options.SelectMethod = $arg.Substring('--select-method='.Length).Trim()
    }
  }

  return $options
}

function Test-WeChatDesktopProcess {
  param([System.Diagnostics.Process]$Process)
  if (-not $Process) { return $false }
  if ($Process.MainWindowHandle -eq 0) { return $false }
  return (($Process.ProcessName -as [string]) -match '^(WeChat|Weixin|WeChatAppEx)$')
}

function Find-WeChatProcess {
  $process = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { Test-WeChatDesktopProcess -Process $_ } |
    Select-Object -First 1

  if ($process) { return $process }

  function Join-OptionalPath {
    param([string]$Base, [string]$Child)
    if ([string]::IsNullOrWhiteSpace($Base)) { return $null }
    return Join-Path $Base $Child
  }

  function Get-AppPathFromRegistry {
    param([string]$Key)
    try {
      $output = & reg.exe query $Key /ve 2>$null
      foreach ($line in $output) {
        if ($line -match 'REG_\w+\s+(.+?)\s*$') {
          return $Matches[1].Trim()
        }
      }
    } catch {}
    return $null
  }

  function Expand-WeChatExecutableCandidate {
    param([string]$Path)
    $items = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($Path)) { return $items }
    $clean = $Path.Trim().Trim('"')
    if (-not [string]::IsNullOrWhiteSpace($clean)) {
      $items.Add($clean)
      if ([IO.Path]::GetFileName($clean) -ieq 'Wexin.exe') {
        $directory = [IO.Path]::GetDirectoryName($clean)
        if ($directory) {
          $items.Add((Join-Path $directory 'Weixin.exe'))
        }
      }
    }
    return $items.ToArray()
  }

  $rawCandidates = @(
    ${env:MAO_WECHAT_EXE_PATH},
    (Join-OptionalPath ${env:ProgramFiles} 'Tencent\Weixin\Weixin.exe'),
    (Join-OptionalPath ${env:ProgramFiles} 'Tencent\WeChat\WeChat.exe'),
    (Join-OptionalPath ${env:ProgramFiles(x86)} 'Tencent\Weixin\Weixin.exe'),
    (Join-OptionalPath ${env:ProgramFiles(x86)} 'Tencent\WeChat\WeChat.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Tencent\Weixin\Weixin.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Tencent\WeChat\WeChat.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Programs\Tencent\Weixin\Weixin.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Programs\Tencent\WeChat\WeChat.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Microsoft\WindowsApps\Weixin.exe'),
    (Join-OptionalPath ${env:LOCALAPPDATA} 'Microsoft\WindowsApps\WeChat.exe'),
    (Get-AppPathFromRegistry 'HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe'),
    (Get-AppPathFromRegistry 'HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe'),
    (Get-AppPathFromRegistry 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe'),
    (Get-AppPathFromRegistry 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe'),
    (Get-AppPathFromRegistry 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe'),
    (Get-AppPathFromRegistry 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe'),
    ((Get-Command Weixin.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source),
    ((Get-Command WeChat.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source)
  )

  $candidates = @($rawCandidates |
    ForEach-Object { Expand-WeChatExecutableCandidate $_ } |
    Where-Object { $_ -and (Test-Path $_) } |
    Select-Object -Unique)

  if ($candidates.Count -gt 0) {
    Write-AutoLog "starting WeChat from $($candidates[0])"
    Start-Process -FilePath $candidates[0] | Out-Null
    for ($i = 0; $i -lt 20; $i += 1) {
      Start-Sleep -Milliseconds 500
      $process = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { Test-WeChatDesktopProcess -Process $_ } |
        Select-Object -First 1
      if ($process) { return $process }
    }
  }

  return $null
}

function Get-WindowRect {
  param([IntPtr]$Handle)
  $rect = New-Object MaoWin32+RECT
  if (-not [MaoWin32]::GetWindowRect($Handle, [ref]$rect)) {
    throw 'Cannot read WeChat window bounds.'
  }
  return @{
    Left = $rect.Left
    Top = $rect.Top
    Right = $rect.Right
    Bottom = $rect.Bottom
    Width = $rect.Right - $rect.Left
    Height = $rect.Bottom - $rect.Top
  }
}

function Get-ForegroundWindowInfo {
  $handle = [MaoWin32]::GetForegroundWindow()
  $pidValue = [uint32]0
  [MaoWin32]::GetWindowThreadProcessId($handle, [ref]$pidValue) | Out-Null
  $name = ''
  $title = ''
  try {
    $foregroundProcess = Get-Process -Id ([int]$pidValue) -ErrorAction Stop
    $name = $foregroundProcess.ProcessName
    $title = $foregroundProcess.MainWindowTitle
  } catch {}
  return @{
    Handle = $handle
    ProcessId = [int]$pidValue
    ProcessName = $name
    Title = $title
  }
}

function Format-ForegroundInfo {
  param([hashtable]$Info)
  if (-not $Info) { return 'none' }
  $title = (($Info.Title -as [string]) -replace '\s+', ' ').Trim()
  if ($title.Length -gt 48) { $title = $title.Substring(0, 48) + '...' }
  return "pid=$($Info.ProcessId) process=$($Info.ProcessName) title=$title"
}

function Test-WeChatForeground {
  param([System.Diagnostics.Process]$Process)
  if (-not $Process) { return $false }
  $info = Get-ForegroundWindowInfo
  if ($info.ProcessId -eq $Process.Id) { return $true }
  if (($info.ProcessName -as [string]) -match '^(WeChat|Weixin|WeChatAppEx)$') { return $true }
  return $false
}

function Invoke-AltPulse {
  [MaoWin32]::keybd_event([byte]$script:VK_MENU, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [MaoWin32]::keybd_event([byte]$script:VK_MENU, 0, [uint32]$script:KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}

function Invoke-WeChatForeground {
  param([System.Diagnostics.Process]$Process, [string]$Reason = 'activate')
  if (-not $Process) { return $false }
  try { $Process.Refresh() } catch {}
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return $false }
  $flags = [uint32]($script:SWP_NOMOVE -bor $script:SWP_NOSIZE -bor $script:SWP_SHOWWINDOW)
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    [MaoWin32]::ShowWindowAsync($handle, $script:SW_RESTORE) | Out-Null
    Start-Sleep -Milliseconds 100
    try {
      $shell = New-Object -ComObject WScript.Shell
      $shell.AppActivate($Process.Id) | Out-Null
    } catch {}
    [MaoWin32]::BringWindowToTop($handle) | Out-Null
    [MaoWin32]::SetWindowPos($handle, $script:HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null
    [MaoWin32]::SetWindowPos($handle, $script:HWND_NOTOPMOST, 0, 0, 0, 0, $flags) | Out-Null
    Invoke-AltPulse
    $setResult = [MaoWin32]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds (220 + ($attempt * 80))
    if (Test-WeChatForeground -Process $Process) {
      Write-AutoLog "foreground verified reason=$Reason attempt=$attempt pid=$($Process.Id)"
      return $true
    }
    $foreground = Format-ForegroundInfo (Get-ForegroundWindowInfo)
    Write-AutoLog "foreground attempt failed reason=$Reason attempt=$attempt setResult=$setResult foreground=$foreground"
  }
  return $false
}

function Assert-WeChatForeground {
  param([System.Diagnostics.Process]$Process = $script:ActiveWeChatProcess, [string]$Context = 'operation')
  if (-not $Process) { return }
  if (Test-WeChatForeground -Process $Process) { return }
  Invoke-WeChatForeground -Process $Process -Reason "assert-$Context" | Out-Null
  if (Test-WeChatForeground -Process $Process) { return }
  $foreground = Format-ForegroundInfo (Get-ForegroundWindowInfo)
  throw "WeChat is not foreground before $Context; foreground=$foreground. Stop to avoid operating the wrong app."
}

function Activate-WeChat {
  $process = Find-WeChatProcess
  if (-not $process) {
    throw 'WeChat window was not found. Please open and log in to desktop WeChat.'
  }
  if (-not (Invoke-WeChatForeground -Process $process -Reason 'activate')) {
    $foreground = Format-ForegroundInfo (Get-ForegroundWindowInfo)
    throw "Cannot bring WeChat to foreground; foreground=$foreground."
  }
  $rect = Get-WindowRect -Handle $process.MainWindowHandle
  $script:ActiveWeChatProcess = $process
  Write-AutoLog "activated WeChat pid=$($process.Id) process=$($process.ProcessName) title=$($process.MainWindowTitle) rect=$($rect.Left),$($rect.Top),$($rect.Width)x$($rect.Height)"
  return @{ Process = $process; Rect = $rect }
}

function Click-Point {
  param([int]$X, [int]$Y, [string]$Name)
  Assert-WeChatForeground -Context "click-$Name"
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
  Start-Sleep -Milliseconds 80
  [MaoWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [MaoWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-AutoLog "clicked $Name at $X,$Y"
  Start-Sleep -Milliseconds 220
}

function Set-ClipboardTextSafe {
  param([string]$Text)
  [System.Windows.Forms.Clipboard]::SetText($Text)
  Start-Sleep -Milliseconds 80
}

function Set-ClipboardFilesSafe {
  param([string[]]$Paths)
  $collection = New-Object System.Collections.Specialized.StringCollection
  foreach ($path in $Paths) {
    if (Test-Path $path) {
      [void]$collection.Add((Resolve-Path $path).Path)
    } else {
      Write-AutoLog "image path missing: $path"
    }
  }
  if ($collection.Count -gt 0) {
    [System.Windows.Forms.Clipboard]::SetFileDropList($collection)
    Start-Sleep -Milliseconds 120
  }
  return $collection.Count
}

function Paste-Clipboard {
  Assert-WeChatForeground -Context 'paste'
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 450
}

function Clear-Input {
  Assert-WeChatForeground -Context 'clear-input'
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
  Start-Sleep -Milliseconds 120
}

function Normalize-RoomText {
  param([string]$Value)
  if ($null -eq $Value) { return '' }
  return ($Value `
    -replace '\uFF5E','~' `
    -replace '\u301C','~' `
    -replace '\uFF0D','-' `
    -replace '\u2014','-' `
    -replace '\u2013','-' `
    -replace '\u2026','' `
    -replace '\u22EF','' `
    -replace '\|','' `
    -replace '\uFF5C','' `
    -replace '\u4E28','' `
    -replace '\uFF3B','' `
    -replace '\uFF3D','' `
    -replace '[\s\u00A0\u2005\u2006]+','')
}

function Get-LcsLength {
  param([char[]]$Left, [char[]]$Right)
  if ($Left.Count -eq 0 -or $Right.Count -eq 0) { return 0 }
  $previous = New-Object int[] ($Right.Count + 1)
  $current = New-Object int[] ($Right.Count + 1)
  foreach ($leftChar in $Left) {
    $current[0] = 0
    for ($i = 0; $i -lt $Right.Count; $i += 1) {
      if ($leftChar -eq $Right[$i]) {
        $current[$i + 1] = $previous[$i] + 1
      } else {
        $current[$i + 1] = [Math]::Max($previous[$i + 1], $current[$i])
      }
    }
    $tmp = $previous
    $previous = $current
    $current = $tmp
  }
  return $previous[$Right.Count]
}

function Get-RoomTextSimilarity {
  param([string]$Value, [string]$Room)
  $targetText = Normalize-RoomText $Room
  $normalizedText = Normalize-RoomText $Value
  if (-not $targetText -or -not $normalizedText) { return 0.0 }
  if ($targetText -eq $normalizedText) { return 1.0 }
  $target = [char[]]$targetText
  $normalized = [char[]]$normalizedText
  $longer = [Math]::Max($target.Count, $normalized.Count)
  if ($longer -le 4) { return 0.0 }
  $shorter = [Math]::Max(1, [Math]::Min($target.Count, $normalized.Count))
  $coverage = $shorter / [Math]::Max(1, $target.Count)
  if ($coverage -lt 0.5) { return 0.0 }
  $lcs = Get-LcsLength -Left $target -Right $normalized
  return $lcs / $shorter
}

function Test-RoomTextMatches {
  param([string]$Value, [string]$Room)
  $target = Normalize-RoomText $Room
  $normalized = Normalize-RoomText $Value
  if (-not $target -or -not $normalized) { return $false }
  if ($normalized -eq $target) { return $true }
  foreach ($line in (($Value -as [string]) -split "`r?`n")) {
    if ((Normalize-RoomText $line) -eq $target) { return $true }
  }
  if ($target.Length -ge 5 -and $normalized.Length -ge 5 -and (Get-RoomTextSimilarity -Value $Value -Room $Room) -ge 0.8) {
    return $true
  }
  if (-not $normalized.StartsWith($target)) { return $false }
  $rest = $normalized.Substring($target.Length)
  if (-not $rest) { return $true }
  $fullWidthLeftParen = [string]([char]0xFF08)
  $yesterday = [string]([char]0x6628) + [string]([char]0x5929)
  foreach ($prefix in @('[', '(', $fullWidthLeftParen, '@', $yesterday, 'Yesterday')) {
    if ($rest.StartsWith($prefix)) { return $true }
  }
  return ($rest[0] -match '\d')
}

function Test-RoomSearchTextMatches {
  param([string]$Value, [string]$Room)
  if (Test-RoomTextMatches -Value $Value -Room $Room) { return $true }
  $target = Normalize-RoomText $Room
  $normalized = Normalize-RoomText $Value
  if ($target.Length -lt 3 -or $normalized.Length -lt 3) { return $false }
  if ($target.StartsWith($normalized) -or $normalized.StartsWith($target)) { return $true }
  return (Get-RoomTextSimilarity -Value $Value -Room $Room) -ge 0.8
}

function Get-LeftPaneMaxX {
  param([hashtable]$Rect)
  return [int]($Rect.Left + [Math]::Min(360, [Math]::Max(280, $Rect.Width * 0.36)))
}

function Get-SearchResultX {
  param([hashtable]$Rect)
  return [int]($Rect.Left + [Math]::Min(210, [Math]::Max(145, $Rect.Width * 0.18)))
}

function Get-AutomationElements {
  param([System.Diagnostics.Process]$Process)
  $uiaType = [type]::GetType('System.Windows.Automation.AutomationElement, UIAutomationClient')
  if (-not $uiaType) { return @() }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    if (-not $root) { return @() }
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $items = New-Object System.Collections.Generic.List[object]
    $limit = [Math]::Min($elements.Count, 2600)
    for ($i = 0; $i -lt $limit; $i += 1) {
      $element = $elements.Item($i)
      $name = ''
      $controlType = ''
      $automationId = ''
      $isKeyboardFocusable = $false
      try { $name = $element.Current.Name } catch {}
      try { $controlType = $element.Current.ControlType.ProgrammaticName } catch {}
      try { $automationId = $element.Current.AutomationId } catch {}
      try { $isKeyboardFocusable = [bool]$element.Current.IsKeyboardFocusable } catch {}
      if ([string]::IsNullOrWhiteSpace($name) -and $controlType -notmatch 'Edit|Document') { continue }
      $bounds = $null
      try { $bounds = $element.Current.BoundingRectangle } catch {}
      if ($null -eq $bounds -or $bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
      $items.Add([pscustomobject]@{
        Name = $name
        ControlType = $controlType
        AutomationId = $automationId
        IsKeyboardFocusable = $isKeyboardFocusable
        X = [double]($bounds.X + ($bounds.Width / 2))
        Y = [double]($bounds.Y + ($bounds.Height / 2))
        Left = [double]$bounds.X
        Top = [double]$bounds.Y
        Width = [double]$bounds.Width
        Height = [double]$bounds.Height
      })
    }
    return $items
  } catch {
    Write-AutoLog "UIAutomation read failed: $($_.Exception.Message)"
    return @()
  }
}

function Test-ActiveRoom {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect, [string]$Room)
  try { $Process.Refresh() } catch {}
  if (Test-RoomTextMatches -Value $Process.MainWindowTitle -Room $Room) {
    Write-AutoLog "verified active room by window title room=$Room title=$($Process.MainWindowTitle)"
    return $true
  }

  $minX = $Rect.Left + [Math]::Min(260, [Math]::Max(185, $Rect.Width * 0.26))
  $maxY = $Rect.Top + 150
  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($item in (Get-AutomationElements -Process $Process)) {
    if (-not (Test-RoomTextMatches -Value $item.Name -Room $Room)) { continue }
    if ($item.X -gt $minX -and $item.X -le $Rect.Right -and $item.Y -ge $Rect.Top -and $item.Y -le $maxY) {
      Write-AutoLog "verified active room by UIAutomation header room=$Room text=$($item.Name) point=$([int]$item.X),$([int]$item.Y)"
      return $true
    }
    if ($matches.Count -lt 5) {
      $matches.Add("$($item.Name)@$([int]$item.X),$([int]$item.Y)")
    }
  }
  if ($matches.Count -gt 0) {
    Write-AutoLog "active room text candidates outside header room=$Room candidates=$($matches -join ';')"
  }
  return $false
}

function Wait-ActiveRoom {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect, [string]$Room, [int]$Attempts = 3)
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    if (Test-ActiveRoom -Process $Process -Rect $Rect -Room $Room) { return $true }
    Write-AutoLog "active room verify attempt $attempt failed room=$Room"
    Start-Sleep -Milliseconds 420
  }
  return $false
}

function Test-UsefulSearchRowText {
  param([string]$Text)
  $trimmed = ($Text -as [string]).Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return $false }
  $compact = Normalize-RoomText $trimmed
  if ([string]::IsNullOrWhiteSpace($compact)) { return $false }
  $searchText = [string]([char]0x641C) + [string]([char]0x7D22)
  $searchWebText = [string]([char]0x641C) + [string]([char]0x4E00) + [string]([char]0x641C)
  $multiplySign = [string]([char]0x00D7)
  if (@('Q', $searchText, $searchWebText, 'x', 'X', $multiplySign, 'AI') -contains $trimmed) { return $false }
  if (@('Q', $searchText, $searchWebText, 'x', 'X', $multiplySign, 'AI') -contains $compact) { return $false }
  if ($trimmed -match '^\d{1,2}:\d{2}$') { return $false }
  if ($trimmed -match '^\d+$') { return $false }
  return $true
}

function Get-SearchResultRowHits {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect)
  $leftMax = Get-LeftPaneMaxX -Rect $Rect
  $minX = $Rect.Left + 45
  $maxX = $leftMax + 220
  $minY = $Rect.Top + 82
  $maxY = $Rect.Top + [Math]::Min(360, $Rect.Height - 54)
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($item in (Get-AutomationElements -Process $Process)) {
    if ($item.X -lt $minX -or $item.X -gt $maxX) { continue }
    if ($item.Y -lt $minY -or $item.Y -gt $maxY) { continue }
    if (-not (Test-UsefulSearchRowText -Text $item.Name)) { continue }
    $items.Add($item)
  }

  $sorted = @($items | Sort-Object @{ Expression = 'Y'; Ascending = $true }, @{ Expression = 'X'; Ascending = $true })
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($item in $sorted) {
    if ($rows.Count -gt 0) {
      $last = $rows[$rows.Count - 1]
      $sumY = 0.0
      foreach ($entry in $last) { $sumY += [double]$entry.Y }
      $centerY = $sumY / [Math]::Max(1, $last.Count)
      if ([Math]::Abs([double]$item.Y - $centerY) -le 28) {
        $last.Add($item)
        continue
      }
    }
    $row = New-Object System.Collections.Generic.List[object]
    $row.Add($item)
    $rows.Add($row)
  }

  $hits = New-Object System.Collections.Generic.List[object]
  $rowNumber = 1
  foreach ($row in $rows) {
    if ($rowNumber -gt 3) { break }
    $rowItems = @($row | Sort-Object @{ Expression = 'X'; Ascending = $true })
    $texts = @()
    foreach ($entry in $rowItems) { $texts += $entry.Name }
    $clickItem = $null
    foreach ($entry in $rowItems) {
      if ($entry.X -ge ($Rect.Left + 115)) {
        $clickItem = $entry
        break
      }
    }
    if ($null -eq $clickItem -and $rowItems.Count -gt 0) { $clickItem = $rowItems[0] }
    if ($null -ne $clickItem) {
      $hit = [pscustomobject]@{
        Row = $rowNumber
        Text = ($texts -join ' | ')
        X = [int]$clickItem.X
        Y = [int]$clickItem.Y
      }
      $hits.Add($hit)
      Write-AutoLog "UIAutomation search result row $($hit.Row) text=$($hit.Text) point=$($hit.X),$($hit.Y)"
    }
    $rowNumber += 1
  }
  if ($hits.Count -eq 0) {
    Write-AutoLog 'UIAutomation search result row hits none'
  }
  return $hits
}

function Get-SearchResultCandidates {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect)
  $searchX = Get-SearchResultX -Rect $Rect
  $searchCenterY = $Rect.Top + 55
  $maxY = $Rect.Top + [Math]::Min(300, [Math]::Max(225, $Rect.Height - 64))
  $candidates = New-Object System.Collections.Generic.List[object]
  $seen = @{}

  function Add-Candidate {
    param([int]$X, [int]$Y, [string]$Reason)
    if ($Y -gt $maxY) { $Y = [int]$maxY }
    $key = "$X,$Y"
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = $true
    $candidates.Add([pscustomobject]@{ X = $X; Y = $Y; Reason = $Reason })
  }

  $rowHits = Get-SearchResultRowHits -Process $Process -Rect $Rect
  $index = 1
  foreach ($offset in @(64, 104, 144)) {
    $rowHit = @($rowHits | Where-Object { $_.Row -eq $index } | Select-Object -First 1)
    if ($rowHit.Count -gt 0) {
      Add-Candidate -X ([int]$rowHit[0].X) -Y ([int]$rowHit[0].Y) -Reason "uia-row-$index-$($rowHit[0].Text)"
    } else {
      Add-Candidate -X ([int]$searchX) -Y ([int]($searchCenterY + $offset)) -Reason "search-below-input-row-$index"
    }
    $index += 1
  }
  $summaryParts = @()
  foreach ($candidate in $candidates) {
    $summaryParts += "$($candidate.Reason)=$($candidate.X),$($candidate.Y)"
  }
  Write-AutoLog "search result probe candidates $($summaryParts -join ';')"

  return $candidates
}

function Click-SearchResult {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect, [string]$Room, [int]$ProbeIndex = 1)
  $candidates = Get-SearchResultCandidates -Process $Process -Rect $Rect
  if ($candidates.Count -eq 0) {
    throw "No selectable WeChat search result candidates for room: $Room"
  }
  $candidateIndex = [Math]::Max(0, [Math]::Min($candidates.Count - 1, $ProbeIndex - 1))
  $candidate = $candidates[$candidateIndex]
  Write-AutoLog "click search result probe room=$Room probeIndex=$ProbeIndex reason=$($candidate.Reason) point=$($candidate.X),$($candidate.Y)"
  Click-Point -X $candidate.X -Y $candidate.Y -Name "search result candidate"
  Start-Sleep -Milliseconds 900
  if (Wait-ActiveRoom -Process $Process -Rect $Rect -Room $Room -Attempts 3) {
    return $candidate.Reason
  }
  throw "WeChat search probe rows were not confirmed for room: $Room"
}

function Focus-SearchField {
  param([hashtable]$Rect)
  $searchX = $Rect.Left + 240
  $searchY = $Rect.Top + 55
  Click-Point -X $searchX -Y $searchY -Name 'search'
}

function Select-ChatsTab {
  param([hashtable]$Rect)
  $chatX = $Rect.Left + 58
  $chatY = $Rect.Top + 142
  Click-Point -X $chatX -Y $chatY -Name 'message home tab'
}

function Reset-ToMessageHomeForSearch {
  param([hashtable]$Rect)
  Write-AutoLog 'reset to message home before search'
  Assert-WeChatForeground -Context 'reset-search'
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 180
  Select-ChatsTab -Rect $Rect
  Start-Sleep -Milliseconds 220
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 160
}

function Open-Room {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect, [string]$Room)
  if (Wait-ActiveRoom -Process $Process -Rect $Rect -Room $Room -Attempts 2) {
    Write-AutoLog "active room already open; skip search room=$Room"
    return 'already-open'
  }

  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    Write-AutoLog "search room attempt $attempt/3 room=$Room"
    Reset-ToMessageHomeForSearch -Rect $Rect
    Focus-SearchField -Rect $Rect
    Clear-Input
    Set-ClipboardTextSafe -Text $Room
    Paste-Clipboard
    Start-Sleep -Milliseconds (850 + ($attempt * 250))
    try {
      $selection = Click-SearchResult -Process $Process -Rect $Rect -Room $Room -ProbeIndex $attempt
      if (Wait-ActiveRoom -Process $Process -Rect $Rect -Room $Room -Attempts 3) {
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Milliseconds 180
        Write-AutoLog "search room verified room=$Room attempt=$attempt selection=$selection"
        return $selection
      }
    } catch {
      Write-AutoLog "search room attempt $attempt/3 failed room=$Room error=$($_.Exception.Message)"
      Reset-ToMessageHomeForSearch -Rect $Rect
    }
  }

  throw "WeChat search result was not confirmed for room: $Room"
}

function Get-MessageInputPoint {
  param([System.Diagnostics.Process]$Process, [hashtable]$Rect)
  if (-not $Process) { return $null }
  $minX = $Rect.Left + [Math]::Min(260, [Math]::Max(185, $Rect.Width * 0.26))
  $minY = $Rect.Top + ($Rect.Height * 0.68)
  $maxY = $Rect.Bottom - 18
  $candidates = New-Object System.Collections.Generic.List[object]

  foreach ($item in (Get-AutomationElements -Process $Process)) {
    if ($item.X -le $minX -or $item.X -gt ($Rect.Right - 16)) { continue }
    if ($item.Y -lt $minY -or $item.Y -gt $maxY) { continue }
    if ($item.Width -lt 90 -or $item.Height -lt 20) { continue }
    if (($item.Name -as [string]) -match '\u641C\u7D22|Search') { continue }
    $looksEditable = (($item.ControlType -as [string]) -match 'Edit|Document') -or [bool]$item.IsKeyboardFocusable
    if (-not $looksEditable) { continue }
    $clickX = [int][Math]::Min($item.Left + $item.Width - 42, $item.Left + [Math]::Min(92, [Math]::Max(56, $item.Width * 0.14)))
    $candidates.Add([pscustomobject]@{
      X = $clickX
      Y = [int]$item.Y
      Area = [double]($item.Width * $item.Height)
      ControlType = $item.ControlType
      Name = $item.Name
      Bounds = "$([int]$item.Left),$([int]$item.Top),$([int]$item.Width)x$([int]$item.Height)"
    })
  }

  $best = @($candidates | Sort-Object @{ Expression = 'Area'; Descending = $true } | Select-Object -First 1)
  if ($best.Count -gt 0) {
    Write-AutoLog "message input UIAutomation point controlType=$($best[0].ControlType) name=$($best[0].Name) point=$($best[0].X),$($best[0].Y) bounds=$($best[0].Bounds)"
    return $best[0]
  }
  Write-AutoLog 'message input UIAutomation point not found'
  return $null
}

function Focus-MessageInput {
  param([hashtable]$Rect, [System.Diagnostics.Process]$Process = $null)
  $detected = Get-MessageInputPoint -Process $Process -Rect $Rect
  if ($detected) {
    Click-Point -X $detected.X -Y $detected.Y -Name 'message input detected'
    return
  }
  $leftPaneMax = $Rect.Left + [Math]::Min(260, [Math]::Max(185, $Rect.Width * 0.26))
  $inputX = [int][Math]::Min($Rect.Right - 110, [Math]::Max($leftPaneMax + 42, $leftPaneMax + 72))
  $inputY = [int]($Rect.Bottom - 78)
  Write-AutoLog "message input fallback point=$inputX,$inputY"
  Click-Point -X $inputX -Y $inputY -Name 'message input'
}

function Move-CursorToInputEnd {
  param([hashtable]$Rect, [System.Diagnostics.Process]$Process = $null)
  Focus-MessageInput -Rect $Rect -Process $Process
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  Start-Sleep -Milliseconds 160
}

function Get-DraftText {
  param([hashtable]$Rect, [System.Diagnostics.Process]$Process = $null, [string]$Context)
  $sentinel = '__MAO_EMPTY_DRAFT_CHECK__' + [guid]::NewGuid().ToString() + '__'
  Focus-MessageInput -Rect $Rect -Process $Process
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.Clipboard]::SetText($sentinel)
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 140
  $copied = ''
  try { $copied = [System.Windows.Forms.Clipboard]::GetText() } catch {}
  $draft = if ($copied -eq $sentinel) { '' } else { $copied }
  $preview = ($draft -replace "`r", '\r' -replace "`n", '\n')
  if ($preview.Length -gt 80) { $preview = $preview.Substring(0, 80) + '...' }
  Write-AutoLog "$Context draft text length=$($draft.Length) preview=$preview"
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  Start-Sleep -Milliseconds 120
  return $draft
}

function Test-DraftContainsBody {
  param([string]$Draft, [string]$Body)
  $compactBody = (($Body -as [string]) -replace '\s+', '')
  if ([string]::IsNullOrWhiteSpace($compactBody)) { return $true }
  $compactDraft = (($Draft -as [string]) -replace '\s+', '')
  if ($compactDraft.Contains($compactBody)) { return $true }
  $prefixLength = [Math]::Min(18, $compactBody.Length)
  if ($prefixLength -lt 6) { return $false }
  return $compactDraft.Contains($compactBody.Substring(0, $prefixLength))
}

function Mention-Members {
  param([string[]]$Mentions)
  foreach ($name in $Mentions) {
    Assert-WeChatForeground -Context 'mention'
    [System.Windows.Forms.SendKeys]::SendWait('@')
    Start-Sleep -Milliseconds 220
    Set-ClipboardTextSafe -Text $name
    Paste-Clipboard
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Write-AutoLog "selected mention: $name"
    Start-Sleep -Milliseconds 350
  }
}

function Press-SendEnter {
  Assert-WeChatForeground -Context 'send-enter'
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-AutoLog 'pressed Enter for send'
  Start-Sleep -Milliseconds 500
}

function Send-AndVerify {
  param([hashtable]$Rect, [System.Diagnostics.Process]$Process = $null)
  Press-SendEnter
  Start-Sleep -Milliseconds 500
  $remaining = Get-DraftText -Rect $Rect -Process $Process -Context 'after send attempt 1'
  if ([string]::IsNullOrWhiteSpace($remaining)) {
    Write-AutoLog 'send verified draft cleared'
    return
  }

  Write-AutoLog "send attempt 1 left non-empty draft length=$($remaining.Length); retry Enter once"
  Press-SendEnter
  Start-Sleep -Milliseconds 600
  $remaining = Get-DraftText -Rect $Rect -Process $Process -Context 'after send attempt 2'
  if ([string]::IsNullOrWhiteSpace($remaining)) {
    Write-AutoLog 'send verified draft cleared after retry'
    return
  }
  $preview = ($remaining -replace "`r", '\r' -replace "`n", '\n')
  if ($preview.Length -gt 36) { $preview = $preview.Substring(0, 36) + '...' }
  throw "WeChat message was not confirmed sent; draft remains ($($remaining.Length) chars): $preview"
}

$options = Parse-Options
Write-AutoLog "started args=$($RestArgs -join ' ')"

if ($options.CheckPermission) {
  Write-AutoLog 'permission check ok on Windows'
  Emit-Json @{ ok = $true; platform = 'win32'; trusted = $true; permissionRequired = $false; logPath = $LogPath }
  exit 0
}

if ($options.OpenRetryTest -and -not $options.Room) {
  throw 'Missing --room.'
}

$session = Activate-WeChat
$rect = $session.Rect
$selection = ''
if ($options.Room) {
  $selection = Open-Room -Process $session.Process -Rect $rect -Room $options.Room
  $session = Activate-WeChat
  $rect = $session.Rect
}

if ($options.OpenRetryTest) {
  Emit-Json @{
    ok = $true
    platform = 'win32'
    action = 'open-retry-test'
    roomName = $options.Room
    selection = $selection
    logPath = $LogPath
  }
  exit 0
}

Focus-MessageInput -Rect $rect -Process $session.Process

if ($options.KeyboardTest -or $options.KeyboardEnterTest) {
  $text = 'keyboard-test-' + (Get-Date -Format 'HHmmss')
  Set-ClipboardTextSafe -Text $text
  Paste-Clipboard
  if ($options.KeyboardEnterTest) {
    Press-SendEnter
  }
  Emit-Json @{ ok = $true; platform = 'win32'; text = $text; pressEnter = [bool]$options.KeyboardEnterTest; logPath = $LogPath }
  exit 0
}

if (-not $options.Room) { throw 'Missing --room.' }
$pastedImages = 0
$hasTextMessage = ($options.Mentions.Count -gt 0) -or (-not [string]::IsNullOrWhiteSpace($options.Text))

if ($options.Send -and $options.Images.Count -gt 0) {
  Write-AutoLog "send image message before text count=$($options.Images.Count)"
  $pastedImages = Set-ClipboardFilesSafe -Paths $options.Images.ToArray()
  if ($pastedImages -gt 0) {
    Paste-Clipboard
    Start-Sleep -Milliseconds 1000
    Send-AndVerify -Rect $rect -Process $session.Process
    Start-Sleep -Milliseconds 700
    Focus-MessageInput -Rect $rect -Process $session.Process
    Clear-Input
    Write-AutoLog 'image message sent; refocused input for text message'
  } else {
    Write-AutoLog 'no image files pasted; continue text message'
  }
}

if ($hasTextMessage) {
  Mention-Members -Mentions $options.Mentions.ToArray()
  if ($options.Text) {
    Move-CursorToInputEnd -Rect $rect -Process $session.Process
    $prefix = if ($options.Mentions.Count -gt 0) { "`r`n" } else { "" }
    Set-ClipboardTextSafe -Text ($prefix + $options.Text)
    Paste-Clipboard
    Start-Sleep -Milliseconds 500
    $draftAfterBody = Get-DraftText -Rect $rect -Process $session.Process -Context 'after body paste'
    if (-not (Test-DraftContainsBody -Draft $draftAfterBody -Body $options.Text)) {
      Write-AutoLog 'body text missing after paste; retry once'
      Move-CursorToInputEnd -Rect $rect -Process $session.Process
      Set-ClipboardTextSafe -Text ($prefix + $options.Text)
      Paste-Clipboard
      Start-Sleep -Milliseconds 500
      $draftAfterBody = Get-DraftText -Rect $rect -Process $session.Process -Context 'after body paste retry'
    }
    if (-not (Test-DraftContainsBody -Draft $draftAfterBody -Body $options.Text)) {
      throw 'WeChat body text was not written into the input box; stop to avoid sending only mentions.'
    }
    Move-CursorToInputEnd -Rect $rect -Process $session.Process
  }
} else {
  Write-AutoLog 'skip text message because mention/body are empty'
}

if (-not $options.Send -and $options.Images.Count -gt 0) {
  $pastedImages = Set-ClipboardFilesSafe -Paths $options.Images.ToArray()
  if ($pastedImages -gt 0) {
    Paste-Clipboard
    Start-Sleep -Milliseconds 1000
  }
}

if ($options.Send) {
  if ($hasTextMessage) {
    Send-AndVerify -Rect $rect -Process $session.Process
  } elseif ($pastedImages -le 0) {
    Write-AutoLog 'nothing to send: no text and no pasted images'
  }
}

Emit-Json @{
  ok = $true
  platform = 'win32'
  roomName = $options.Room
  mentions = $options.Mentions.ToArray()
  sent = [bool]$options.Send
  requestedImages = $options.Images.Count
  pastedImages = $pastedImages
  selection = $selection
  logPath = $LogPath
}
