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
                   → auto-commit.py（偵測確認關鍵字後自動 git commit）

PreToolUse(WebFetch) → webfetch-hook.js（自訂 WebFetch 前置處理）

PostToolUse        → obs-mask-hook.js（超長工具結果外部化）
PostToolUse(Bash)  → bash-fail-guard.py（連續失敗警告）

Stop               → usage-tracker.py（記錄 token 用量）
```

### Hook 詳細說明

#### `cwd-guard.py`（UserPromptSubmit）
- **目的**：防止在非預期目錄開 Claude session
- **機制**：讀取當前工作目錄，比對白名單；不符合則 `exit(2)` 阻斷 prompt，訊息不送至 LLM
- **白名單目錄**：僅允許特定的幾個工作目錄（MyClaw 專案、Netivism 業務、agent 全域設定）

#### `auto-commit.py`（UserPromptSubmit）
- **目的**：在使用者回覆確認成功時，自動為特定專案執行 git commit
- **觸發關鍵字**：「成功了」「這版可以」「commit」「存檔」
- **機制**：偵測到關鍵字 → `git add . && git commit` → 注入系統訊息告知使用者（不消耗 LLM token）

#### `bash-fail-guard.py`（PostToolUse, Bash）
- **目的**：防止 Claude 無限重試失敗的 Bash 命令
- **機制**：per-session 計數器（tempfile），Bash 連續失敗 ≥ 2 次時注入警告，要求停止重試、分析根本原因、等待使用者確認替代方案

#### `obs-mask-hook.js`（PostToolUse, 全工具）
- **目的**：壓縮 context，防止過長的工具結果塞爆 context window
- **機制**：工具輸出超過 2000 字元時，寫入 `~/.claude/obs-cache/` 暫存檔，context 中只保留摘要路徑
- **排除工具**：Write、Edit、NotebookEdit、TodoWrite、TodoRead、Task（這些輸出本來就短或是寫入操作）
- **清理**：每天首次執行時，自動刪除 30 天未修改的暫存檔

摘要格式：
```
[觀測結果已外部化至暫存檔：/path/to/obs-cache/Read_xxx.txt，共 N 行 / M 字元。若需完整內容，請用 Read 工具讀取該路徑。]
```

Claude 看到此摘要時：若任務需要完整內容，主動 Read 該路徑；若只需部分資訊，可直接推斷不必讀取。

---

## 四、模型路由系統（AgentOpt 風格）

### 架構

`route_model.py` 掛載為 UserPromptSubmit hook（目前以 inline 方式於 CLAUDE.md 中說明規則），對每則 prompt 做 pattern matching，在 context 中注入路由指示：

```
[MODEL_ROUTER] tier=haiku reason=mechanical_operation
[MODEL_ROUTER] tier=opus reason=deep_reasoning_no_write
[MODEL_ROUTER] tier=sonnet reason=default strategy=use_deepwiki_first
```

### 分類規則

| Tier | 觸發條件 | Claude 的處理方式 |
|------|----------|-------------------|
| **haiku** | 機械性操作：list/find/search/grep/read/執行/統計等，且無 opus signal | 用 `Agent(model="haiku")` 執行任務本體，自己只做最終整合回覆 |
| **opus** | 深度推理：架構設計/系統設計/效能瓶頸/根本原因分析，且**無寫入意圖** | 用 `Agent(model="opus")` 執行純推理部分（勿寫檔），自行整合輸出 |
| **sonnet** | 預設（含所有有寫入意圖的任務） | 正常自行處理 |

### 特殊邏輯

- **救援模式**：最近 4 則訊息出現 ≥ 2 個失敗訊號（抱歉/出錯/報錯等）→ 強制路由到 opus
- **寫入保護**：即使命中 opus pattern，只要 prompt 含有寫入意圖（write/create/add/implement/寫/建立等）→ 維持 sonnet 自行執行（因 Opus 有時跳過工具直接從記憶回答）
- **策略附加**：同時命中 netiCRM codebase + 架構探索 pattern → 附加 `strategy=use_deepwiki_first`

### haiku 委派規則

- 適用：預期需要 3 次以上工具呼叫的探索/搜尋任務
- 不適用：純文字生成、摘要、預期 0–2 次工具呼叫的簡單查詢（直接 inline 更省）
- 委派 prompt 末尾固定加：「請以條列式回傳結論與關鍵數據，不含推理過程。」

---

## 五、Slash Commands（使用者可呼叫的技能模式）

以下是 `~/.claude/commands/` 下的模式指令，使用者輸入 `/command-name` 時觸發：

### `/neticrm`：netiCRM 規劃專家

**角色**：根據 Redmine 議題原始資料（客服單、討論串），搭配 netiCRM codebase 技術分析，產出需求規劃文件。

**核心限制**：
- `update_redmine_issue` 禁止使用 `description` 參數（Redmine 概述由使用者手動更新）
- 未獲使用者指示，禁止主動操作 Redmine（含新增 notes）
- `list_redmine_issues` 必須指定 project_id + 版本範圍，禁止全撈

**工作流程**：
1. 進入模式時檢查 netiCRM codebase 是否為最新（每週四晚間更新）
2. 依使用者指定的 issue_id 或 query 取得議題
3. 搜尋 codebase 確認實際程式邏輯
4. 依最新 SOP/模板填寫規劃內容
5. 存為 `output/#{issue_number}_{簡短標題}.md`

**Codebase 搜尋策略**：
- 簡單搜尋（單一關鍵字）→ 直接 Grep
- 複雜探索（跨模組追蹤、需讀上下文、涉及 2+ 目錄）→ 用 `Agent(Explore)` subagent

**多則議題**：spawn 多個 subagent 並行處理，主對話彙整結果。

---

### `/neticrm-wiki-assistant`：netiCRM Wiki 助理

**角色**：協助整理、調整、改寫 Wiki 內容。**只輸出內容，不執行任何 Redmine 寫入操作。**

**允許工具**：get_redmine_wiki、search_wiki_history、get_redmine_issue、list_redmine_issues、get_issue_relations、download_issue_images（均為唯讀）

**絕對禁止**：update_redmine_issue、create_redmine_issue、add_issue_relation 及任何寫入 Redmine 的操作

**輸出格式**：存為 `output/wiki/{page_title}_{YYYYMMDD}.md`，頂部加免責聲明標注來源與日期。

---

### `/new-project`：新專案模式

**用途**：初始化新專案時的引導問答流程。

**流程**：依序詢問（一次一題）：
1. 專案目標（一兩句話）
2. 主要使用的 MCP 工具（可說不確定）
3. 產出存放路徑（預設 `output/{專案名}/`）

收集完畢後，確認摘要給使用者看，等確認後正式開始協作。

---

### `/security`：資安與隱私政策執行專家

**角色**：依據 ISMS 規範與個資安全維護計畫，協助 MCP 設定稽核與資安合規確認。

**參考文件策略**（文件很大，禁止整份讀取）：
1. 先讀目錄確認章節位置
2. 用 `offset + limit` 定向讀取相關段落

**憑證管理硬性限制**：
- 禁止讀取 `.mcp.json`
- 禁止讀取、列印 `.env`、`.pem`、`.key`、`.p12` 等憑證檔案
- 禁止讀取 `~/.claude.json` 中 env 的憑證值（KEY/TOKEN/SECRET/PASSWORD）
- MCP 設定異動後，由使用者手動確認憑證存放，Claude 不做驗證

**稽核流程**：
1. 確認 MCP 設定的 mcpServers 區塊（僅讀取非憑證欄位）
2. 逐項檢查：工具範圍最小權限原則、憑證存放位置、Server 是否為本機執行
3. 對照 ISMS 規範
4. 產出稽核紀錄：`output/security/mcp_audit_{YYYYMMDD}.md`

---

## 六、專案層級 CLAUDE.md

全域 CLAUDE.md（`agent_global_configs/CLAUDE.md`）提供跨專案的底線規則，各專案目錄可再加一層 CLAUDE.md 覆蓋或補充。

### Netivism/claude 專案

**用途**：netiCRM / Netivism 業務相關任務（Redmine 議題規劃、Wiki 撰寫、行銷發文等）。

**MCP 工具庫**：

| 工具群組 | 前綴 |
|---------|------|
| Redmine | `mcp__redmine__*` |
| Google Calendar | `mcp__claude_ai_Google_Calendar__*` |
| netiCRM Connector | `mcp__claude_ai_netiCRM_Connector__*` |

> 禁止直接呼叫 Redmine API 或 Transifex API（curl/fetch/HTTP 請求），一律透過 MCP。

**自動偵測專家模式**：第一則訊息後，根據語意自動以 Skill tool 載入對應專家，無需詢問：

| 偵測條件 | 載入技能 |
|---------|---------|
| MCP、憑證、資安、ISMS、個資、稽核、隱私 | `/security` |
| Wiki、文件說明、功能說明頁、netiCRM 使用說明 | `/neticrm-wiki-assistant` |
| Redmine、排程、流程規劃、需求、開站、導入 | `/neticrm` |
| 無法判斷 | 簡短列出選項，請使用者選擇 |

使用者也可直接輸入 `/security`、`/neticrm`、`/neticrm-wiki-assistant` 覆蓋自動判斷。

**跨專家強制規則**（任何模式均適用）：對話中出現以下任一情境，**必須先載入 `/security` 完成稽核後再繼續原任務**：
- 新增 MCP Server
- 修改現有 MCP 設定（endpoint、工具清單、env 參數名稱）
- 新增或輪替 API Key / Token / Secret

---

### MyClaw 專案

**用途**：Telegram Bot（@leondeClawBot）的程式碼本體，日常維護與開發。此專案的 CLAUDE.md 非常精簡，行為規則完全繼承全域 CLAUDE.md。

---

## 八、架構關係圖

```
使用者輸入
    │
    ▼
UserPromptSubmit Hooks
  ├── cwd-guard.py        ← 白名單檢查（可能阻斷）
  ├── auto-commit.py      ← 關鍵字偵測自動 commit
  └── route_model.py      ← 注入 [MODEL_ROUTER] tier hint
    │
    ▼
CLAUDE.md 全域規則 + context
  ├── 安全規範（MCP 確認、憑證保護）
  ├── Session 管理
  ├── 新方法確認流程
  └── Read 工具策略
    │
    ▼
Claude LLM 決策
  ├── 若 tier=haiku → Agent(model="haiku") 執行
  ├── 若 tier=opus  → Agent(model="opus") 推理
  └── 若 tier=sonnet → 直接執行
    │
    ▼
Tool 呼叫
    │
    ▼
PostToolUse Hooks
  ├── obs-mask-hook.js    ← 超長結果外部化（≥2000 字元）
  └── bash-fail-guard.py  ← 連續失敗警告（≥2 次）
    │
    ▼
Stop Hook
  └── usage-tracker.py   ← 記錄 token 用量
```

---

## 九、MCP 整合原則

- 所有外部服務（Redmine、CRM 等）透過本機已設定的 MCP Server 存取
- **讀取操作**：可自主執行
- **寫入操作**：必須先出草稿讓使用者確認，明確回覆後才呼叫
- 無對應 MCP 時，明確告知「此服務尚未設定 MCP，請回到本機設定後再操作」

---

## 十、Anthropic Skills（內建技能）

Claude Code 透過 Skill 工具呼叫，提供額外功能（例如 `/commit` 自動生成 commit 訊息、`/review-pr` 審查 PR 等）。技能清單由系統動態載入，不固定。

---

*本文件生成日期：2026-04-16。架構持續演進，以實際設定檔為準。*
