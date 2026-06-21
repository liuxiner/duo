param(
  [string]$Room = "",
  [string[]]$Mentions = @(),
  [string]$Text = "",
  [string[]]$Images = @(),
  [string]$HelperPath = "",
  [switch]$Send,
  [switch]$OpenOnly,
  [switch]$KeyboardOnly,
  [switch]$KeyboardEnter,
  [switch]$PressReturnOnly,
  [switch]$PrintLogs,
  [switch]$DebugCapture,
  [int]$LogLines = 120,
  [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

function Repo-Root {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Resolve-HelperPath {
  param([string]$InputPath)
  if (-not [string]::IsNullOrWhiteSpace($InputPath)) {
    if (-not (Test-Path $InputPath)) { throw "HelperPath not found: $InputPath" }
    return (Resolve-Path $InputPath).Path
  }

  $root = Repo-Root
  $candidates = @(
    (Join-Path $PSScriptRoot 'wechat-automation.ps1'),
    (Join-Path $PSScriptRoot 'mao-wechat-automation.ps1'),
    (Join-Path (Get-Location) 'wechat-automation.ps1'),
    (Join-Path (Get-Location) 'mao-wechat-automation.ps1'),
    (Join-Path $root 'desktop\native\windows\wechat-automation.ps1'),
    (Join-Path $root 'dist\runtime\bin\mao-wechat-automation.ps1')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }
  throw 'WeChat automation helper was not found. Put wechat-automation.ps1 next to this script, or pass -HelperPath.'
}

function Short-Line {
  param([string]$Value, [int]$Max = 800)
  $text = ($Value -as [string]).Trim()
  if ($text.Length -le $Max) { return $text }
  return $text.Substring(0, $Max) + '...'
}

function Default-HelperLogPath {
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  return Join-Path $local ("DuoduoDigitalManager\logs\wechat-desktop-automation-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
}

function Default-HelperLogDir {
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  return Join-Path $local 'DuoduoDigitalManager\logs'
}

function Print-HelperLogTail {
  param([string]$Path, [string]$Reason)
  if ([string]::IsNullOrWhiteSpace($Path)) { $Path = Default-HelperLogPath }
  Write-Host ""
  Write-Host "== helper log tail: $Reason =="
  Write-Host "log: $Path"
  if (-not (Test-Path $Path)) {
    Write-Host "log not found"
    return
  }
  Get-Content -Path $Path -Tail $LogLines | ForEach-Object { Write-Host $_ }
}

function Invoke-WeChatHelper {
  param([string[]]$HelperArgs, [string]$Label)
  Write-Host ""
  Write-Host "== $Label =="
  Write-Host ("helper args: " + ($HelperArgs -join ' '))

  $oldDebugCapture = $env:MAO_WECHAT_DEBUG_CAPTURE
  $oldDebugDir = $env:MAO_WECHAT_DEBUG_DIR
  $stepDebugDir = ''
  if ($DebugCapture) {
    $script:DebugStepSeq += 1
    $labelSafe = (($Label -as [string]) -replace '[^A-Za-z0-9._-]+', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($labelSafe)) { $labelSafe = 'step' }
    $stepDebugDir = Join-Path $script:DebugRoot ("{0:00}-{1}" -f $script:DebugStepSeq, $labelSafe)
    $env:MAO_WECHAT_DEBUG_CAPTURE = 'true'
    $env:MAO_WECHAT_DEBUG_DIR = $stepDebugDir
    Write-Host "debug dir: $stepDebugDir"
  }

  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:ResolvedHelperPath @HelperArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $env:MAO_WECHAT_DEBUG_CAPTURE = $oldDebugCapture
    $env:MAO_WECHAT_DEBUG_DIR = $oldDebugDir
  }
  $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
  if ($text.Trim()) { Write-Host (Short-Line $text) }

  $logPath = Default-HelperLogPath
  $lastLine = @($text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
  if ($lastLine.Count -gt 0 -and $lastLine[0].Trim().StartsWith('{')) {
    try {
      $payload = $lastLine[0] | ConvertFrom-Json
      if ($payload.logPath) {
        $logPath = [string]$payload.logPath
        Write-Host "log: $logPath"
      }
      if ($payload.debugDir) {
        Write-Host "debug: $($payload.debugDir)"
      }
    } catch {}
  }

  if ($exitCode -ne 0) {
    Print-HelperLogTail -Path $logPath -Reason "$Label failed"
    if ($DebugCapture -and -not [string]::IsNullOrWhiteSpace($stepDebugDir)) {
      Write-Host "debug: $stepDebugDir"
    }
    throw "Step failed: $Label (exit=$exitCode)"
  }

  if ($PrintLogs) {
    Print-HelperLogTail -Path $logPath -Reason "$Label ok"
  }
}

function Build-SendArgs {
  $items = New-Object System.Collections.Generic.List[string]
  $items.Add("--room=$Room")
  if ($Mentions.Count -gt 0) {
    $items.Add("--mentions=$($Mentions -join ',')")
  } else {
    $items.Add('--mentions=')
  }
  $items.Add("--text=$Text")
  if ($Send) { $items.Add('--send') } else { $items.Add('--dry-run') }
  $items.Add('--select-method=click-first')
  foreach ($image in $Images) {
    $trimmed = ($image -as [string]).Trim()
    if ($trimmed) { $items.Add("--image=$trimmed") }
  }
  return $items.ToArray()
}

$script:ResolvedHelperPath = Resolve-HelperPath $HelperPath
$script:DebugStepSeq = 0
$root = Repo-Root
$env:MAO_APP_ROOT = if ($env:MAO_APP_ROOT) { $env:MAO_APP_ROOT } else { Join-Path $root 'dist\runtime' }
$env:MAO_WORKSPACE_PATH = if ($env:MAO_WORKSPACE_PATH) { $env:MAO_WORKSPACE_PATH } else { $root }
if ($DebugCapture) {
  $script:DebugRoot = Join-Path (Default-HelperLogDir) ("wechat-debug-test-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $script:DebugRoot -Force | Out-Null
}

Write-Host "WeChat RPA test"
Write-Host "repo: $root"
Write-Host "helper: $script:ResolvedHelperPath"
Write-Host "mode: $(if ($Send) { 'SEND' } else { 'DRY-RUN' })"
$logTailMode = if ($PrintLogs) { "$LogLines lines after each step" } else { 'only on failure' }
Write-Host "log tail: $logTailMode"
if ($DebugCapture) {
  Write-Host "debug root: $script:DebugRoot"
}

if (-not $SkipPreflight) {
  Invoke-WeChatHelper -Label 'preflight' -HelperArgs @('--check-permission')
}

if ($PressReturnOnly) {
  Invoke-WeChatHelper -Label 'press return only' -HelperArgs @('--press-return-only')
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Room)) {
  throw 'Missing -Room. Use a test group first.'
}

if ([string]::IsNullOrWhiteSpace($Text)) {
  $Text = 'wechat-rpa-smoke ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
}

if ($OpenOnly) {
  Invoke-WeChatHelper -Label 'open room only' -HelperArgs @('--open-retry-test', "--room=$Room")
  exit 0
}

if ($KeyboardOnly) {
  Invoke-WeChatHelper -Label 'keyboard paste only' -HelperArgs @('--keyboard-test', "--room=$Room")
  exit 0
}

if ($KeyboardEnter) {
  Invoke-WeChatHelper -Label 'keyboard enter send test' -HelperArgs @('--keyboard-enter-test', "--room=$Room")
  exit 0
}

Invoke-WeChatHelper -Label 'open room' -HelperArgs @('--open-retry-test', "--room=$Room")
Invoke-WeChatHelper -Label 'compose message' -HelperArgs (Build-SendArgs)

if ($Send) {
  Write-Host "Done. Message send was requested."
} else {
  Write-Host "Done. Dry-run only: the draft may remain in the WeChat input box."
}
