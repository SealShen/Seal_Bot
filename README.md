# Seal_Bot — Claude Code 全域設定

個人 Claude Code 環境的全域設定，包含：行為規範、Hooks、Slash Commands、模型路由腳本。

## 結構

```
├── CLAUDE.md                    # 全域行為規範（安全規則、session 管理等）
├── architecture-overview.md     # 整體架構說明
├── settings.example.json        # settings.json 範本（複製後依路徑修改）
│
├── hooks/                       # Claude Code Hooks
│   ├── cwd-guard.py             # UserPromptSubmit：工作目錄白名單檢查
│   ├── auto-commit.py           # UserPromptSubmit：關鍵字觸發自動 git commit
│   ├── bash-fail-guard.py       # PostToolUse(Bash)：連續失敗警告
│   └── obs-mask-hook.js         # PostToolUse：超長工具結果外部化
│
├── commands/                    # Slash Commands（~/.claude/commands/ 複製）
│   ├── neticrm.md
│   ├── neticrm-wiki-assistant.md
│   ├── new-project.md
│   └── security.md
│
└── scripts/
    └── router-savings-report.py # 估算 haiku sub-agent 節省的 token 量
```

## 快速開始

### 1. 複製到本機

```bash
git clone https://github.com/leond/Seal_Bot.git ~/agent_global_configs
```

### 2. 設定 Hooks

複製 `settings.example.json` 為 `~/.claude/settings.json`，修改其中的路徑：

```bash
cp settings.example.json ~/.claude/settings.json
# 然後編輯 ~/.claude/settings.json，將路徑替換為實際位置
```

### 3. 設定各 Hook 的個人路徑

**`hooks/cwd-guard.py`** — 修改 `WHITELIST` 為你允許開 Claude session 的目錄：
```python
WHITELIST = [
    '~/your-project',
    '~/agent_global_configs',
]
```

**`hooks/auto-commit.py`** — 修改 `project_path` 為你要自動 commit 的專案：
```python
project_path = os.path.expanduser("~/your-project")
```

**`scripts/router-savings-report.py`** — 修改 `PROJECT_DIRS` 為你的 `~/.claude/projects/` 子目錄名稱。

### 4. 部署 Slash Commands

```bash
cp commands/*.md ~/.claude/commands/
```

### 5. 設定 CLAUDE.md

將 `CLAUDE.md` 的內容整合進 `~/.claude/CLAUDE.md`（全域）或專案層級的 `CLAUDE.md`。

---

## 主要功能說明

### Observation Masking（obs-mask-hook.js）

工具輸出超過 2000 字元時，自動寫入 `~/.claude/obs-cache/` 暫存檔，context 中只保留路徑摘要，大幅降低 context 用量。

### 安全規範

詳見 [CLAUDE.md](CLAUDE.md)。核心原則：MCP 寫入操作必須先出草稿讓使用者確認；憑證絕不硬編碼。
