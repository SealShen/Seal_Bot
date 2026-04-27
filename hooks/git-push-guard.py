#!/usr/bin/env python3
"""
PreToolUse(Bash) hook: 攔截 git push，自動掃描個人識別資訊與機敏資料。

掃描失敗 → exit(2) 阻斷，並輸出問題清單給 Claude。
掃描通過 → exit(0) 放行。

觸發條件：Bash 指令中含有 "git push"
"""
import sys
import json
import os
import subprocess
import re


# ── 讀取 hook 輸入 ─────────────────────────────────────────────────────────────
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)

tool_name  = data.get('tool_name', '')
tool_input = data.get('tool_input', {})
command    = tool_input.get('command', '') if isinstance(tool_input, dict) else ''

# 只處理實際執行 git push 的 Bash 指令（排除 echo/字串內含有 "git push" 的情況）
# 拆解 shell 指令片段（&&、;、|、換行），檢查是否有片段以 git push 開頭
def _is_git_push_cmd(cmd):
    parts = re.split(r'[;&|\n]', cmd)
    return any(re.match(r'\s*git(?:\.exe)?\s+push\b', p) for p in parts)

if tool_name != 'Bash' or not _is_git_push_cmd(command):
    sys.exit(0)

# # noscan 逃生艙：在 push 指令末尾加上 # noscan 可跳過掃描
if '# noscan' in command:
    print('[git-push-guard] SKIP: noscan flag set.')
    sys.exit(0)

# ── 取得本機系統帳號（Windows / Unix 通用） ────────────────────────────────────
sys_user = (
    os.environ.get('USERNAME') or       # Windows
    os.environ.get('USER') or           # Linux/macOS
    os.environ.get('LOGNAME') or
    ''
).strip().lower()

# ── 掃描模式 ───────────────────────────────────────────────────────────────────
PATTERNS = []

# 1. 系統帳號出現在路徑中
if sys_user:
    PATTERNS.append((
        re.compile(rf'[/\\]users[/\\]{re.escape(sys_user)}[/\\]', re.IGNORECASE),
        f'本機路徑含系統帳號 "{sys_user}"（應替換為 env var 或 <username>）'
    ))
    PATTERNS.append((
        re.compile(rf'(?<![a-zA-Z0-9_-]){re.escape(sys_user)}(?![a-zA-Z0-9_-])', re.IGNORECASE),
        f'檔案內容含系統帳號 "{sys_user}"'
    ))

# 2. API token / secret 格式
PATTERNS.append((
    re.compile(r'(?i)(api[_-]?key|secret|password|token)\s*=\s*["\']?[A-Za-z0-9_\-]{16,}'),
    '疑似 API key / secret 直接寫入檔案'
))

# 3. Telegram bot token 格式（數字:英數）
PATTERNS.append((
    re.compile(r'\b\d{8,12}:[A-Za-z0-9_\-]{35,}\b'),
    '疑似 Telegram Bot Token'
))

# 4. 電子郵件
PATTERNS.append((
    re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'),
    '電子郵件地址'
))

# 5. 機敏副檔名不應出現在 git tracked 檔案列表
SENSITIVE_EXTS = re.compile(r'\.(env|pem|key|p12|pfx|jsonl)$', re.IGNORECASE)

# ── 取得即將 push 的 diff ──────────────────────────────────────────────────────
def run(cmd, cwd=None):
    try:
        r = subprocess.run(
            cmd, capture_output=True, timeout=15, cwd=cwd,
            encoding='utf-8', errors='replace',  # Windows cp950 安全繞過
        )
        return r.stdout or '', r.returncode
    except Exception:
        return '', 1

# 取得 remote 名稱（從 push 指令中抓，預設 origin）
remote_match = re.search(r'git push\s+(?:--\S+\s+)*(\S+)', command)
remote = remote_match.group(1) if remote_match else 'origin'
if remote.startswith('-'):
    remote = 'origin'

# ── Layer 1: review marker 檢查 ────────────────────────────────────────────────
# 強制流程：所有 unpushed commits 必須有 "Reviewed-by:" trailer 才能 push。
# Grandfather: 既存 "Co-Authored-By: Claude" commits 視為已 review（過渡兼容）。
# Bypass: 在 push 指令末尾加 # noreview。
NOREVIEW = '# noreview' in command

REVIEW_TRAILER = re.compile(r'^Reviewed-by:\s*\S+', re.MULTILINE)

def _get_unpushed_commits():
    # 用 \x1f / \x1e 當分隔避免 commit message 內字元干擾
    out, _ = run(['git', 'log', f'{remote}/HEAD..HEAD', '--format=%H%x1f%B%x1e'])
    if not out:
        # Fallback：新 branch 或無 upstream
        out, _ = run(['git', 'log', '-1', '--format=%H%x1f%B%x1e'])
    commits = []
    for entry in (out or '').split('\x1e'):
        entry = entry.strip()
        if not entry or '\x1f' not in entry:
            continue
        sha, msg = entry.split('\x1f', 1)
        commits.append((sha.strip(), msg))
    return commits

if not NOREVIEW:
    unreviewed = []
    for sha, msg in _get_unpushed_commits():
        if REVIEW_TRAILER.search(msg):
            continue
        first_line = (msg.strip().splitlines() or ['(empty)'])[0][:60]
        unreviewed.append(f'{sha[:8]} "{first_line}"')
    if unreviewed:
        msg_lines = [
            '[git-push-guard] BLOCKED: 以下 commits 未經 review。',
            '',
            'Unreviewed commits:',
        ]
        msg_lines += [f'  - {x}' for x in unreviewed[:10]]
        msg_lines += [
            '',
            'Action（任選一）：',
            '  1. 跑 /review-flow → 自動 review→修改→測試→commit-with-trailer→push',
            '  2. 人工確認後加 trailer：',
            '     git commit --amend --no-edit --trailer "Reviewed-by: human"',
            '  3. 逃生艙：在 push 指令末尾加 # noreview',
        ]
        print('\n'.join(msg_lines))
        sys.exit(2)

# 取得尚未推送到 remote 的 commits 包含的檔案內容
diff_out, _ = run(['git', 'diff', f'{remote}/HEAD..HEAD'])
if not diff_out:
    # fallback：與 HEAD~1 比較
    diff_out, _ = run(['git', 'diff', 'HEAD~1..HEAD'])
if not diff_out:
    # 新 repo：掃描 HEAD 全部追蹤檔案的內容
    diff_out, _ = run(['git', 'show', 'HEAD'])

# 取得即將 push 的追蹤檔案列表
tracked_files, _ = run(['git', 'diff', '--name-only', f'{remote}/HEAD..HEAD'])
if not tracked_files:
    tracked_files, _ = run(['git', 'diff', '--name-only', 'HEAD~1..HEAD'])
if not tracked_files:
    tracked_files, _ = run(['git', 'show', '--name-only', '--format=', 'HEAD'])

# ── 執行掃描 ───────────────────────────────────────────────────────────────────
issues = []

# 掃描 diff 內容
for line in diff_out.splitlines():
    if not line.startswith('+') or line.startswith('+++'):
        continue  # 只看新增行
    for pattern, label in PATTERNS:
        if pattern.search(line):
            short = line[1:].strip()[:120]
            issues.append(f'[{label}]\n  → {short}')
            break  # 同一行只報一次

# 掃描追蹤檔案名稱
for fname in tracked_files.splitlines():
    fname = fname.strip()
    if SENSITIVE_EXTS.search(fname):
        issues.append(f'[機敏副檔名] 檔案 "{fname}" 不應被 git 追蹤，請加入 .gitignore')

# ── 輸出結果 ───────────────────────────────────────────────────────────────────
if issues:
    deduped = list(dict.fromkeys(issues))  # 保序去重
    msg_lines = [
        '[git-push-guard] BLOCKED: git push aborted. Issues found:',
        '',
    ]
    for i, issue in enumerate(deduped[:20], 1):
        msg_lines.append(f'{i}. {issue}')
    msg_lines += [
        '',
        'Fix the above issues, recommit, then push again.',
        'To skip scan (false positive), append # noscan to the push command.',
    ]
    print('\n'.join(msg_lines))
    sys.exit(2)

# 通過掃描
print('[git-push-guard] OK: no personal identifiers or sensitive data found.')
sys.exit(0)
