param(
  [int]$Lines = 200
)

$ErrorActionPreference = 'Stop'
$path = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) (
  'DuoduoDigitalManager\logs\wechat-desktop-automation-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd')
)

Write-Host $path
if (Test-Path $path) {
  Get-Content -Path $path -Tail $Lines
} else {
  Write-Host 'log not found'
}
