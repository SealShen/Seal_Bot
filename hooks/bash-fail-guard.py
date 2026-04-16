#!/usr/bin/env python3
"""
PostToolUse hook: 連續 Bash 失敗 2 次時，強制注入警告訊息，要求 Claude 停止重試。
"""
import sys
import json
import os
import tempfile

data = json.loads(sys.stdin.read())

tool_name = data.get('tool_name', '')
if tool_name != 'Bash':
    sys.exit(0)

# 從 session_id 建立獨立計數器檔案
session_id = data.get('session_id', 'default')
counter_file = os.path.join(tempfile.gettempdir(), f'claude_bash_fail_{session_id}.txt')

# 判斷是否失敗
response = data.get('tool_response', {})
exit_code = None
if isinstance(response, dict):
    exit_code = response.get('exit_code')
    if exit_code is None:
        exit_code = response.get('returncode')

is_failure = (exit_code is not None and exit_code != 0)

if is_failure:
    try:
        with open(counter_file, 'r') as f:
            count = int(f.read().strip())
    except Exception:
        count = 0
    count += 1
    with open(counter_file, 'w') as f:
        f.write(str(count))

    if count >= 2:
        print(
            f'[系統警示] Bash 已連續失敗 {count} 次。'
            '請停止重試相同方法，先分析根本原因，提出替代方案並等待使用者確認後再繼續。'
        )
else:
    # 成功則歸零
    try:
        os.remove(counter_file)
    except Exception:
        pass
