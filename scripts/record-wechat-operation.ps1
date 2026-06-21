param(
  [int]$DurationSeconds = 120,
  [int]$IntervalMs = 80,
  [string]$OutputDir = "data\wechat-operation-recordings",
  [string]$CaseId = "",
  [switch]$NoScreenshots,
  [switch]$IncludeCharacterKeys,
  [switch]$Append
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MaoRecorderWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }
}
"@

try {
  [MaoRecorderWin32]::SetProcessDPIAware() | Out-Null
} catch {}

function Local-Timestamp {
  return (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
}

function Safe-FilePart {
  param([string]$Value)
  $clean = ($Value -replace '[\\/:*?"<>|]', '-').Trim()
  if ([string]::IsNullOrWhiteSpace($clean)) { return "case" }
  return $clean
}

if ([string]::IsNullOrWhiteSpace($CaseId)) {
  $CaseId = "wechat-operation-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}
$CaseId = Safe-FilePart $CaseId
$CaseDir = Join-Path $OutputDir $CaseId
$ScreenshotDir = Join-Path $CaseDir "screenshots"
$EventsPath = Join-Path $CaseDir "events.jsonl"
$ManifestPath = Join-Path $CaseDir "manifest.json"
$ZipPath = Join-Path $OutputDir "$CaseId.zip"

if ((Test-Path $CaseDir) -and -not $Append) {
  Remove-Item -Path $CaseDir -Recurse -Force
}
if ((Test-Path $ZipPath) -and -not $Append) {
  Remove-Item -Path $ZipPath -Force
}

New-Item -ItemType Directory -Path $ScreenshotDir -Force | Out-Null

$script:StartedAt = Get-Date
$script:ScreenshotSeq = 0
if ($Append -and (Test-Path $ScreenshotDir)) {
  $existingSeq = @(Get-ChildItem -Path $ScreenshotDir -Filter "*.png" -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.Name -match '^(\d+)-') { [int]$Matches[1] }
    } |
    Sort-Object -Descending |
    Select-Object -First 1)
  if ($existingSeq.Count -gt 0) {
    $script:ScreenshotSeq = [int]$existingSeq[0]
  }
}
$script:LastScreenshotAt = [DateTime]::MinValue

function Get-ElapsedMs {
  return [int]((Get-Date) - $script:StartedAt).TotalMilliseconds
}

function Get-CursorPoint {
  $point = New-Object MaoRecorderWin32+POINT
  [MaoRecorderWin32]::GetCursorPos([ref]$point) | Out-Null
  return @{ x = [int]$point.X; y = [int]$point.Y }
}

function Get-ForegroundInfo {
  $handle = [MaoRecorderWin32]::GetForegroundWindow()
  $pidValue = [uint32]0
  [MaoRecorderWin32]::GetWindowThreadProcessId($handle, [ref]$pidValue) | Out-Null
  $builder = New-Object System.Text.StringBuilder 512
  [MaoRecorderWin32]::GetWindowText($handle, $builder, $builder.Capacity) | Out-Null
  $processName = ""
  try {
    $processName = (Get-Process -Id ([int]$pidValue) -ErrorAction Stop).ProcessName
  } catch {}
  return [ordered]@{
    handle = $handle.ToInt64()
    pid = [int]$pidValue
    process = $processName
    title = $builder.ToString()
  }
}

function Is-KeyDown {
  param([int]$VirtualKey)
  return (([MaoRecorderWin32]::GetAsyncKeyState($VirtualKey) -band 0x8000) -ne 0)
}

function Get-Modifiers {
  $items = New-Object System.Collections.Generic.List[string]
  if (Is-KeyDown 0x11) { $items.Add("Ctrl") }
  if (Is-KeyDown 0x10) { $items.Add("Shift") }
  if (Is-KeyDown 0x12) { $items.Add("Alt") }
  if ((Is-KeyDown 0x5B) -or (Is-KeyDown 0x5C)) { $items.Add("Win") }
  return $items.ToArray()
}

function Write-JsonLine {
  param([object]$Payload)
  ($Payload | ConvertTo-Json -Compress -Depth 8) | Add-Content -Path $EventsPath -Encoding UTF8
}

function Save-Screenshot {
  param([string]$Reason)
  if ($NoScreenshots) { return "" }
  $now = Get-Date
  if ((($now - $script:LastScreenshotAt).TotalMilliseconds) -lt 350) { return "" }
  $script:LastScreenshotAt = $now
  $script:ScreenshotSeq += 1
  $name = "{0:D4}-{1}.png" -f $script:ScreenshotSeq, (Safe-FilePart $Reason)
  $path = Join-Path $ScreenshotDir $name
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return $path
}

function Get-VirtualScreenInfo {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return [ordered]@{
    left = [int]$bounds.Left
    top = [int]$bounds.Top
    width = [int]$bounds.Width
    height = [int]$bounds.Height
  }
}

function Add-Event {
  param([string]$Type, [System.Collections.IDictionary]$Data = @{}, [string]$ScreenshotReason = "")
  $payload = [ordered]@{
    ts = Local-Timestamp
    elapsedMs = Get-ElapsedMs
    type = $Type
    cursor = Get-CursorPoint
    foreground = Get-ForegroundInfo
  }
  foreach ($entry in $Data.GetEnumerator()) {
    $payload[$entry.Key] = $entry.Value
  }
  if ($ScreenshotReason) {
    $shot = Save-Screenshot $ScreenshotReason
    if ($shot) { $payload["screenshot"] = $shot }
  }
  Write-JsonLine $payload
}

$keyMap = New-Object System.Collections.Specialized.OrderedDictionary
$keyMap.Add([int]0x08, "Backspace")
$keyMap.Add([int]0x09, "Tab")
$keyMap.Add([int]0x0D, "Enter")
$keyMap.Add([int]0x10, "Shift")
$keyMap.Add([int]0x11, "Ctrl")
$keyMap.Add([int]0x12, "Alt")
$keyMap.Add([int]0x1B, "Escape")
$keyMap.Add([int]0x20, "Space")
$keyMap.Add([int]0x21, "PageUp")
$keyMap.Add([int]0x22, "PageDown")
$keyMap.Add([int]0x23, "End")
$keyMap.Add([int]0x24, "Home")
$keyMap.Add([int]0x25, "Left")
$keyMap.Add([int]0x26, "Up")
$keyMap.Add([int]0x27, "Right")
$keyMap.Add([int]0x28, "Down")
$keyMap.Add([int]0x2E, "Delete")
$keyMap.Add([int]0x5B, "WinLeft")
$keyMap.Add([int]0x5C, "WinRight")
foreach ($code in 0x30..0x39) {
  $keyMap.Add([int]$code, [string][char]$code)
}
foreach ($code in 0x41..0x5A) {
  $keyMap.Add([int]$code, [string][char]$code)
}
foreach ($code in 0x70..0x7B) {
  $keyMap.Add([int]$code, "F" + ($code - 0x6F))
}

function Should-LogKey {
  param([int]$VirtualKey, [string[]]$Modifiers)
  if ($IncludeCharacterKeys) { return $true }
  $isCharacter = (($VirtualKey -ge 0x30 -and $VirtualKey -le 0x39) -or ($VirtualKey -ge 0x41 -and $VirtualKey -le 0x5A) -or $VirtualKey -eq 0x20)
  if (-not $isCharacter) { return $true }
  return ($Modifiers -contains "Ctrl") -or ($Modifiers -contains "Alt") -or ($Modifiers -contains "Win")
}

$manifest = [ordered]@{
  caseId = $CaseId
  startedAt = Local-Timestamp
  durationSeconds = $DurationSeconds
  intervalMs = $IntervalMs
  noScreenshots = [bool]$NoScreenshots
  includeCharacterKeys = [bool]$IncludeCharacterKeys
  append = [bool]$Append
  dpiAwareRequested = $true
  virtualScreen = Get-VirtualScreenInfo
  caseDir = (Resolve-Path $CaseDir).Path
  eventsPath = $EventsPath
  note = "Screenshots can contain private WeChat content. Use a test group when possible."
}
($manifest | ConvertTo-Json -Depth 6) | Set-Content -Path $ManifestPath -Encoding UTF8

Write-Host "Recording Windows WeChat operation for $DurationSeconds seconds."
Write-Host "Output: $CaseDir"
Write-Host "Perform the operation now. Use a test group and avoid sensitive chats."

Add-Event "start" @{ durationSeconds = $DurationSeconds } "start"

$previousLeft = $false
$previousRight = $false
$previousKeys = @{}
$previousForeground = Get-ForegroundInfo
$deadline = (Get-Date).AddSeconds($DurationSeconds)

while ((Get-Date) -lt $deadline) {
  $foreground = Get-ForegroundInfo
  if ($foreground.handle -ne $previousForeground.handle -or $foreground.title -ne $previousForeground.title) {
    Add-Event "foreground" @{ previous = $previousForeground; current = $foreground } "foreground"
    $previousForeground = $foreground
  }

  $left = Is-KeyDown 0x01
  if ($left -and -not $previousLeft) {
    Add-Event "mouse" @{ button = "left"; action = "down" } "mouse-left"
  }
  $previousLeft = $left

  $right = Is-KeyDown 0x02
  if ($right -and -not $previousRight) {
    Add-Event "mouse" @{ button = "right"; action = "down" } "mouse-right"
  }
  $previousRight = $right

  foreach ($entry in $keyMap.GetEnumerator()) {
    $vk = [int]$entry.Key
    $isDown = Is-KeyDown $vk
    $wasDown = $previousKeys[$vk] -eq $true
    if ($isDown -and -not $wasDown) {
      $modifiers = Get-Modifiers
      if (Should-LogKey $vk $modifiers) {
        Add-Event "key" @{
          key = [string]$entry.Value
          virtualKey = $vk
          modifiers = $modifiers
        } "key-$($entry.Value)"
      }
    }
    $previousKeys[$vk] = $isDown
  }

  Start-Sleep -Milliseconds $IntervalMs
}

Add-Event "stop" @{ durationSeconds = $DurationSeconds } "stop"

$manifest["finishedAt"] = Local-Timestamp
$manifest["zipPath"] = $ZipPath
($manifest | ConvertTo-Json -Depth 6) | Set-Content -Path $ManifestPath -Encoding UTF8

if (Test-Path $ZipPath) {
  Remove-Item -Path $ZipPath -Force
}
Compress-Archive -Path (Join-Path $CaseDir "*") -DestinationPath $ZipPath -Force

$result = [ordered]@{
  ok = $true
  caseId = $CaseId
  caseDir = (Resolve-Path $CaseDir).Path
  zipPath = (Resolve-Path $ZipPath).Path
  eventsPath = (Resolve-Path $EventsPath).Path
  manifestPath = (Resolve-Path $ManifestPath).Path
}
$result | ConvertTo-Json -Compress -Depth 6
