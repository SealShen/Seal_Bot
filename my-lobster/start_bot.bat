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

echo Starting Claude Code Telegram Bot (with auto-restart, log -^> bot.log)...

:loop
echo [%date% %time%] --- Bot starting --- >> bot.log
node bot.js >> bot.log 2>&1
echo [%date% %time%] --- Bot exited with code %errorlevel%, restarting in 5s --- >> bot.log
timeout /t 5 /nobreak >nul
goto loop
