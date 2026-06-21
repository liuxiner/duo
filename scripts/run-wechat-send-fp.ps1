param(
  [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
$answer = Read-Host 'Type SEND to send a real WeChat message to room fp'
if ($answer -ne 'SEND') {
  Write-Host 'Cancelled.'
  exit 1
}

$testScript = Join-Path $PSScriptRoot 'test-wechat-rpa.ps1'
$helperScript = Join-Path $PSScriptRoot 'wechat-automation.ps1'
if (-not (Test-Path $helperScript)) {
  $helperScript = Join-Path $PSScriptRoot 'mao-wechat-automation.ps1'
}
$member = [string]([char]0x5F97) + [string]([char]0x9591) + [string]([char]0x6582) + [string]([char]0x91D1)

$argsList = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $testScript,
  '-HelperPath', $helperScript,
  '-Room', 'fp',
  '-Mentions', $member,
  '-Text', 'wechat-rpa send test',
  '-Send',
  '-PrintLogs'
)
if ($SkipPreflight) { $argsList += '-SkipPreflight' }

& powershell.exe @argsList
exit $LASTEXITCODE
