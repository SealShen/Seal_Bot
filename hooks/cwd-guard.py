#!/usr/bin/env python3
"""
UserPromptSubmit hook: 檢查工作目錄是否在白名單內。
不在白名單時 exit(2) 阻斷 prompt，不送至 LLM。

設定方式：修改下方 WHITELIST，填入你允許開 Claude session 的目錄。
"""
import sys
import json
import os

json.loads(sys.stdin.read())  # 消費 stdin，避免管道阻塞

cwd = os.getcwd().replace('\\', '/').rstrip('/')

# ── 請依個人環境修改 ───────────────────────────────────────────
WHITELIST = [
    '~/path/to/project1',           # e.g. ~/MyClaw
    '~/path/to/project2',           # e.g. ~/work/claude
    '~/agent_global_configs',
]
# ──────────────────────────────────────────────────────────────

# 展開 ~ 並統一格式
expanded = [os.path.expanduser(d).replace('\\', '/').rstrip('/') for d in WHITELIST]

if any(cwd.lower() == d.lower() for d in expanded):
    sys.exit(0)

print(
    f"[BLOCKED] 不允許在此目錄開 Claude session：{cwd}\n"
    f"請切換至以下目錄之一再開啟：\n"
    + "\n".join(f"  • {d}" for d in WHITELIST)
)
sys.exit(2)
