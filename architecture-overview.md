# Claude Code 架構概覽

> 本文件統合了所有影響 agent 行為的指令與機制，供其他 LLM 了解此環境的架構與核心精神。
> 機敏資料（API Key、Token、憑證內容、具體路徑中的 credentials）均已排除。

---

## 一、核心設計哲學

此環境的 Claude Code 設定圍繞三個核心原則：

1. **安全優先**：任何寫入外部服務的動作，必須先獲使用者明確確認。憑證絕不外洩、絕不硬編碼。
2. **context 效率**：透過 Observation Masking、模型路由、Read 工具策略，盡量壓低 token 消耗。
3. **可審計性**：所有行為可追溯（hooks 留下日誌、session 有 tool call 上限提示、模型路由決策透明）。

---

## 二、全域行為規範（CLAUDE.md）

### 操作入口

Claude 可透過兩種方式被呼叫：
- **本地 VSCode**：直接在本機操作
- **Telegram Bot**：白名單限定本人帳號，訊息視為已認證直接輸入

### 安全規範

| 規則 | 說明 |
|------|------|
| MCP 寫入強制確認 | 任何新增/修改/刪除/發佈 MCP 操作，必須先出草稿讓使用者確認，等明確回覆才呼叫 |
| 禁止直接呼叫外部 API | 所有外部服務整合必須透過本機已設定的 MCP Server，無 MCP 時明確告知 |
| 憑證保護 | 禁止讀取 .env/.pem/.key/.p12 等憑證內容；禁止 printenv；禁止讀取含 KEY/TOKEN/SECRET/PASSWORD 的環境變數值後對外使用 |

### Session 管理

- tool calls 累積超過 50 次 → 提示考慮 `/compact` 或開新 session
- 單一任務完成後建議開新 session

### 新方法確認流程

實作前若能預見限制條件、前提需求或已知風險 → **必須先告知，等確認後才開始實作**。禁止先實作再補充告知。

### Read 工具策略

讀取大檔前先用 Grep 找目標行號，再以 `offset + limit` 定向讀取；確認某行是否存在用 Grep，不必 Read 整份。

---

## 三、Hooks 系統

Hooks 是掛載在 Claude Code 事件點上的 Python/Node.js 腳本，由 Claude Code 執行緒觸發，**非 LLM token 消耗**。

### 事件架構

```
UserPromptSubmit   → cwd-guard.py（白名單檢查）
                   → prompt_router.py（LLM 分類器注入 subagent 建議）
                   → heartbeat_notify.py（session 存活通知）

PreToolUse(WebFetch) → webfetch-hook.js（自訂 WebFetch 前置處理）
PreToolUse(Bash)     → git-push-guard.py（git push 前安全掃描）

PostToolUse        → obs-mask-hook.js（超長工具結果外部化）
PostToolUse(Edit)  → auto-commit.py（自動 git commit 單檔）
PostToolUse(Write) → auto-commit.py（自動 git commit 單檔）

Stop               → usage-tracker.py（記錄 token 用量）
```

### Hook 詳細說明

#### `cwd-guard.py`（UserPromptSubmit）
- **目的**：防止在非預期目錄開 Claude session
- **機制**：讀取當前工作目錄，比對白名單；不符合則 `exit(2)` 阻斷 prompt，訊息不送至 LLM

#### `prompt_router.py`（UserPromptSubmit）
- **目的**：為每則 prompt 注入 subagent / 委派建議
- **機制**：LLM 分類器（Google AI Studio Gemma/Flash cascade → 本地 LM Studio fallback）分析 prompt，注入 `[ROUTE] subagent=<type>` 或 `delegate=gemma_chat`
- **決策 log**：`~/.claude/routing-decisions.log`；稽核工具 `routing_report.py`

#### `heartbeat_notify.py`（UserPromptSubmit）
- **目的**：session 存活通知，防止使用者以為 session 卡住

#### `webfetch-hook.js`（PreToolUse, WebFetch）
- **目的**：自訂 WebFetch 前置處理

#### `git-push-guard.py`（PreToolUse, Bash）
- **目的**：攔截 git push 前執行安全掃描
- **機制**：三層檢查 — Layer1 review marker + Layer1.5 metadata scan + Layer2 security scan
- **位置**：`agent_global_configs/hooks/git-push-guard.py`

#### `auto-commit.py`（PostToolUse, Edit/Write）
- **目的**：在專案根目錄有 `.claude-auto-commit` 標記時，每次 Edit/Write 後自動 `git add` + `git commit` 該單一檔案
- **Commit message**：由 Gemma 本地模型根據 diff 產生，失敗則 fallback 為 `chore(<file>): auto-commit`

#### `obs-mask-hook.js`（PostToolUse, 全工具）
- **目的**：壓縮 context，防止過長的工具結果塞爆 context window
- **機制**：工具輸出超過 2000 字元時，寫入 `~/.claude/obs-cache/` 暫存檔，context 中只保留摘要路徑
- **排除工具**：Write、Edit、NotebookEdit、TodoWrite、TodoRead、Task

#### `usage-tracker.py`（Stop）
- **目的**：記錄 token 用量

---

## 四、Slash Commands（使用者可呼叫的技能模式）

以下是 `~/.claude/commands/` 下的模式指令，使用者輸入 `/command-name` 時觸發：

### `/neticrm`：netiCRM 規劃專家

根據 Redmine 議題原始資料搭配 codebase 技術分析產出需求規劃文件。

核心限制：
- `update_redmine_issue` 禁止使用 `description` 參數
- 未獲使用者指示，禁止主動操作 Redmine
- `list_redmine_issues` 必須指定 project_id + 版本範圍

### `/neticrm-wiki-assistant`：netiCRM Wiki 助理

協助整理、改寫 Wiki 內容。只輸出內容，**不執行任何 Redmine 寫入操作**。

### `/new-project`：新專案模式

初始化新專案的引導問答流程（目標、MCP 工具、產出路徑）。

### `/security`：資安與隱私政策執行專家

依據 ISMS 規範與個資安全維護計畫，協助 MCP 設定稽核與資安合規確認。憑證管理有硬性限制（禁讀 `.mcp.json`、憑證檔案、env 憑證值）。

---

## 五、專案層級 CLAUDE.md

全域 CLAUDE.md（`agent_global_configs/CLAUDE.md`）提供跨專案底線規則，各專案可再加一層 CLAUDE.md 補充。

### Netivism/claude 專案
netiCRM / Netivism 業務（Redmine 議題規劃、Wiki 撰寫等）。MCP 工具包含 Redmine、Google Calendar、netiCRM Connector。第一則訊息後根據語意自動載入對應專家模式。

### MyClaw 專案
Telegram Bot 程式碼本體。行為規則繼承全域 CLAUDE.md，額外定義自動 commit 機制與 Haiku 搜尋委派策略。

---

## 六、架構關係圖

```
使用者輸入
    │
    ▼
UserPromptSubmit Hooks
  ├── cwd-guard.py        ← 白名單檢查（可能阻斷）
  ├── prompt_router.py    ← 注入 [ROUTE] subagent/delegate hint
  └── heartbeat_notify.py ← session 存活通知
    │
    ▼
CLAUDE.md 全域規則 + context
  ├── 安全規範（MCP 確認、憑證保護）
  ├── Session 管理
  └── Read 工具策略
    │
    ▼
Claude LLM 決策
  ├── 若 subagent=<type>   → Agent(subagent_type=<type>) 執行
  ├── 若 delegate=gemma_chat → mcp__gemma-local__gemma_chat 處理
  └── 否則                 → 直接執行
    │
    ▼
PreToolUse Hooks
  ├── webfetch-hook.js    ← WebFetch 前置處理
  └── git-push-guard.py   ← git push 安全掃描
    │
    ▼
Tool 呼叫
    │
    ▼
PostToolUse Hooks
  ├── obs-mask-hook.js    ← 超長結果外部化（≥2000 字元）
  └── auto-commit.py      ← Edit/Write 後自動 commit（需 .claude-auto-commit 標記）
    │
    ▼
Stop Hook
  └── usage-tracker.py   ← 記錄 token 用量
```

---

## 七、MCP 整合原則

- 所有外部服務（Redmine、CRM 等）透過本機已設定的 MCP Server 存取
- **讀取操作**：可自主執行
- **寫入操作**：必須先出草稿讓使用者確認，明確回覆後才呼叫
- 無對應 MCP 時，明確告知「此服務尚未設定 MCP，請回到本機設定後再操作」

---

*本文件更新日期：2026-05-01。架構持續演進，以實際設定檔為準。*
