Set-Location (Split-Path $PSCommandPath)
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
