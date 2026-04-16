#!/usr/bin/env python3
"""
UserPromptSubmit hook: 當偵測到確認成功的關鍵字時，自動執行 git commit。

設定方式：修改下方 project_path，填入你要自動 commit 的專案路徑。
"""
import sys
import json
import subprocess
import os

data = json.loads(sys.stdin.read())
prompt = data.get('content', '')

# 觸發自動提交的關鍵字
trigger_keywords = ["成功了", "這版可以", "commit", "存檔"]

if any(keyword in prompt for keyword in trigger_keywords):
    # ── 請依個人環境修改 ────────────────────────────────────────
    project_path = os.path.expanduser("~/path/to/your/project")
    # ──────────────────────────────────────────────────────────

    if os.path.exists(os.path.join(project_path, ".git")):
        try:
            subprocess.run(["git", "-C", project_path, "add", "."], check=True)
            subprocess.run(
                ["git", "-C", project_path, "commit", "-m", f"Auto-commit: {prompt[:20]}"],
                check=True
            )
            print(f"[系統訊息] 偵測到關鍵字，已自動執行 Git Commit。")
        except Exception as e:
            print(f"[系統錯誤] Git 自動提交失敗: {e}")
    else:
        print(f"[系統訊息] 目錄下未發現 Git 儲存庫，請先確認目錄位置。")
