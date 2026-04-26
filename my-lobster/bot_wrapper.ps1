Set-Location (Split-Path $PSCommandPath)
$ErrorActionPreference = 'Continue'
trap {
  $tt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot_wrapper.death.log' -Value "[$tt] TRAP pid=$PID msg=$($_.Exception.Message)" -Encoding UTF8
  continue
}
Register-EngineEvent PowerShell.Exiting -Action {
  $tt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'bot_wrapper.death.log' -Value "[$tt] EXITING pid=$PID last_exit=$global:LASTEXITCODE" -Encoding UTF8
} | Out-Null
$startTs = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path 'bot_wrapper.death.log' -Value "[$startTs] WRAPPER_START pid=$PID host=$env:COMPUTERNAME" -Encoding UTF8
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
