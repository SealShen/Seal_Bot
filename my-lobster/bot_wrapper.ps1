Set-Location (Split-Path $PSCommandPath)
$ErrorActionPreference = 'Continue'
trap {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot_wrapper.death.log' -Value "[$ts] TRAP pid=$PID msg=$($_.Exception.Message)" -Encoding UTF8
  Start-Sleep -Seconds 5
  exit 1
}
Register-EngineEvent PowerShell.Exiting -Action {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot_wrapper.death.log' -Value "[$ts] EXITING pid=$PID" -Encoding UTF8
} | Out-Null
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path 'bot_wrapper.death.log' -Value "[$ts] WRAPPER_START pid=$PID host=$env:COMPUTERNAME" -Encoding UTF8
Write-Host '[wrapper] Starting bot.js (no-admin path)...' -ForegroundColor Cyan
while ($true) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot.log' -Value "`n[$ts] === Bot starting (no-admin wrapper) ===" -Encoding UTF8
  & node bot.js *>> 'bot.log'
  $ec = $LASTEXITCODE
  $ts2 = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot.log' -Value "[$ts2] === Bot exited code=$ec, restarting in 5s ===" -Encoding UTF8
  Write-Host "[wrapper] exited code=$ec, restart in 5s..." -ForegroundColor Yellow
  Start-Sleep -Seconds 5
}
