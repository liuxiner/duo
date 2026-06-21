param(
  [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
$testScript = Join-Path $PSScriptRoot 'test-wechat-rpa.ps1'
$helperScript = Join-Path $PSScriptRoot 'wechat-automation.ps1'
if (-not (Test-Path $helperScript)) {
  $helperScript = Join-Path $PSScriptRoot 'mao-wechat-automation.ps1'
}

$argsList = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $testScript,
  '-HelperPath', $helperScript,
  '-Room', 'fp',
  '-OpenOnly',
  '-PrintLogs'
)
if ($SkipPreflight) { $argsList += '-SkipPreflight' }

& powershell.exe @argsList
exit $LASTEXITCODE
