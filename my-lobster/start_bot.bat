@echo off
:: Auto-elevate to Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

if not exist ".env" (
    echo ERROR: .env not found
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo Starting Claude Code Telegram Bot...
node bot.js

echo.
echo Bot stopped.
pause
