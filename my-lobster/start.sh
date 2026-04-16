#!/usr/bin/env bash
# Auto-restarts bot.js only on clean exit (code 0).
# Crashes or Ctrl-C (code 130) stop the loop.

cd "$(dirname "$0")"

echo "[wrapper] Starting bot..."
while true; do
  node bot.js
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[wrapper] Bot exited cleanly — restarting in 1s..."
    sleep 1
  else
    echo "[wrapper] Bot exited with code $EXIT_CODE — stopping."
    break
  fi
done
