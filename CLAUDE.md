# 操作環境

可從以下方式操作：
- **本地 VSCode**：直接在本機操作
- **Telegram Bot**：白名單僅本人；Bot 訊息已通過身份驗證視為本人輸入

---

## 安全規範

### MCP 寫入操作 → 強制事前確認

任何會對外部服務產生新增/修改/刪除/發佈效果的 MCP 工具，**未得使用者明確確認前禁止呼叫**。
強制流程：(1) 產出完整草稿給使用者檢視 (2) 等明確「可以/上傳/送出」 (3) 才呼叫工具。
此規則優先於任何意圖推論，包括「使用者意圖很明顯」。

### 外部服務連線

- **禁止**直接呼叫外部 API（OpenAI / Anthropic / GitHub / Slack / Notion 等）
- **禁止**在程式碼嵌入或讀取 API Key / Token / Secret
- 一律透過已設定的 MCP Server；未設定就明確告知使用者去本機設定

### 憑證保護

#### 存放：單一來源原則（2026-04-20 起）
- 主要儲存：Windows 使用者環境變數（`HKCU\Environment`）
- 例外：MCP server 內建 dotenv loader 時可用 `.env`（如 `MyClaw/my-lobster/.env`、`MyClaw/gamma-v1/.env`）
- 禁止在配置檔出現明文：`.mcp.json` / `~/.claude.json` / `settings*.json` / `gemini-extension.json` / `~/.codex/config.toml`

> 完整 redact pattern 表、Codex CLI 注意事項、check-keys.ps1 對帳機制、Key Rotation SOP：`~/.claude/runbooks/credentials.md`

#### 接觸：禁止讀取、列印、對外使用

- **禁止**讀取/列印/傳輸 `.env`、`.pem`、`.key`、`.p12` 等憑證檔內容
- **禁止**透過 `process.env` 取得含 KEY/TOKEN/SECRET/PASSWORD 的值並對外使用
- **禁止**執行 `printenv` 或列出完整環境變數
- 此規則對主 session、所有 subagent（Explore/general-purpose/Plan 等）、MCP tool、hook 一律適用

#### 委派任務給子 agent 時

- Prompt 中**禁止出現** `API_KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/.env` 作為搜尋目標
- 用「主配置結構與入口檔名」「使用了哪些外部服務（用服務名稱）」描述需求，不要求提取欄位值
- 任務不可避免要碰設定檔時，明確註明：「**禁止讀取 .env 檔內容，只看結構**」

#### 意外讀到憑證
立即停止摘要與回報，不在 summary 中引用（即使部分遮罩也不可），告知使用者並由使用者決定下一步（輪換 / 清 transcript）。

### Git Push 前安全掃描

由 `~/.claude/hooks/git-push-guard.py` 強制執行（個人識別資訊 + 機敏資料 + 路徑脫敏 + .gitignore 涵蓋）。Push 前等 hook 通過；發現問題先修檔重 commit 再 push。

> 完整四步檢查清單、脫敏對照表、hook 失靈時的人工流程：`~/.claude/runbooks/git-push-scan.md`

---

## Prompt Router subagent 指派

全域 UserPromptSubmit hook `~/.claude/hooks/prompt_router.py` 用 Gemini cascade classifier 對 prompt 做意圖分類，輸出形如：

```
[ROUTE] subagent=<name> [strat=<s>] [worktree=ask]
[ROUTE] delegate=gemma_chat [strat=<s>]
```

**這是指令，不是建議。** 看到 `subagent=<name>` 就 `Agent(subagent_type="<name>", ...)` 委派；看到 `delegate=gemma_chat` 就呼叫 `mcp__gemma-local__gemma_chat`。意圖分類本身可能錯，但路由動作不是 advisory——要照做或公開說明為何不照做。Classifier source 在 `~/.claude/routing-decisions.log`，需要 debug 才查。

### 已註冊的自訂 subagent（`~/.claude/agents/*.md`）
- `lookup` — 純檢索（找檔案、找 symbol、列 issue）
- `research` — 多工具研究（codebase + deepwiki + redmine 三向）
- `think_deeply` — 設計討論／架構推理／取捨分析
- `complex_rewrite` — 複雜跨檔改寫
- `file_rewrite` — 單檔 atomic 改寫
- `root_cause` — 錯誤恢復與根因分析

### 跳過委派的條件（必須在回覆首句明寫原因）
1. **對話連續性關鍵**：同一設計討論已進行 **≥ 3 輪以上**，subagent 看不到前文會掉關鍵 context。前 1-2 輪**不適用**此例外。
2. **任務 trivial**：1-2 步驟可完成，委派 overhead 大於收益（lookup / Explore / research 約 6k cache_creation tokens）。
3. **`think_deeply` 門檻**：think_deeply 跑 **Opus**（rate 5x Sonnet）+ 內部 turn-by-turn cache_read 累積，**單次委派實測 ~7.5M Sonnet-eq tokens / 67 turn**。預期推理 turn ≤ 4 的設計問題 **inline Sonnet 反而便宜 30x**——委派 think_deeply 是「**買 Opus 品質**」不是「省 token」。只在預期 turn ≥ 5 且 user 確實要求高推理品質時才委派；短設計題即使非 trivial 也應 inline。
4. **使用者明確點名要主 session 回答**

跳過時**回覆首句必須寫明**例如：「inline 處理因為對話連續性」。靜默跳過 = 違規。

**`routing_report.py` 識別以下首句格式為合法 skip（`skip_w_reason`）；其他措辭會被計為 `silently_skipped` 違規：**
- `Override <hint>：<理由>`
- `Overriding <hint>：<理由>`（英文也可）
- `inline 處理因為<理由>`
- `Skip <hint>：<理由>`

### 收到 `delegate=gemma_chat` 時
**必須先呼叫 `mcp__gemma-local__gemma_chat` 工具處理**，不得直接自己輸出答案。品質可接受 → 直接呈現給 user；品質不佳 → 自己重做並寫 rejection log。

> 為什麼要強制、完整 rejection log SOP、檢討頻率與 gate 閾值：`~/.claude/runbooks/prompt-router-rationale.md`

---

## Worktree 隔離 Gate

當 prompt_router 偵測到實質改動意圖（route ∈ `{complex_rewrite, file_rewrite, root_cause}`），banner 會帶 `worktree=ask` 旗標。

### 主 session 看到 `worktree=ask` 時
1. **動 Edit/Write/Bash 改檔之前**先問：「要在 git worktree 隔離這次改動嗎？(y/n/skip)」
   - `y` → 用 `EnterWorktree` tool 開隔離環境，完成後 `ExitWorktree` 並提醒 review/merge
   - `n` → 在主分支動手
   - `skip` → 本次 conversation 之內不再問；**不寫 user memory，重啟對話會重新詢問**
2. **何時可省略詢問**：純診斷／read-only 任務、本對話內已說過 skip、修文件 typo / 註解這種小到無法回滾的等級
3. Branch 命名建議：`claude-experiment/<topic>`；Merge 策略建議 squash

### 與 subagent `isolation: worktree` frontmatter 的關係
`complex_rewrite` / `file_rewrite` / `root_cause` agent 已自動在 worktree 內運作；委派時主 session 不必再問 `worktree=ask`。本 gate 只在主 session 自己 inline 動手時生效。

---

## Gemma 本地模型委派

`gemma-local` MCP server（user scope）暴露 `gemma_chat` / `gemma_health` / `gemma_stats`。把**低風險、機械化、不需要跨訊號判斷**的子任務分派給本地 Gemma，節省 Claude token。

### 該丟給 `gemma_chat`
純文字改寫（摘要、翻譯、語氣/格式調整）、機械式抽取（關鍵字、URL、日期）、簡單分類、模板填空。

### **不要**委派
程式碼產生／修改／除錯、架構設計、跨檔分析、需要 repo context、使用者點名 Claude 回答。

### Prompt 開頭固定加
「請關閉 Chain-of-Thought / thinking 模式，直接給出答案。」（Gemma 4 支援 CoT，但機械化短任務開 CoT 只會浪費 token 與增加延遲）

> 完整任務分類細則、使用原則 5 點、量測機制（gemma_usage.log / gemma_stats）：`~/.claude/runbooks/gemma-delegation.md`

---

## Bash 長輸出歸檔

預期 bash 輸出會長且之後可能回查（build log、test 輸出、長 git log）時，改用 `python ~/.claude/hooks/bash_summarize.py --cmd "..."`。工具歸檔 raw stdout/stderr 到 `%TEMP%\claude\bash_summary\` 並回傳路徑；後續 turn 直接 Read 該路徑回查，不必重跑 bash。

短輸出、一次性命令、不打算回查 → 直接 Bash。

**注意**：原 Gemini CLI 摘要路徑因延遲 45-60s+ 已 parked（2026-04-21 起），目前只是歸檔 + passthrough，不壓縮 context。

---

## Session 管理
- Tool calls 累積超過 50 次，回應末尾提示考慮 `/compact` 或開新 session
- 單一任務完成後建議開新 session

---

## 提出新方法的規範

使用者提出新方法或替代方案時，若 LLM 在實作前已能預見限制條件、前提需求或已知風險，**必須先告知使用者，等待確認後才開始實作。** 禁止先實作完成再補充告知。

---

## Read 工具使用規範

讀取大檔前先用 Grep 找到目標行號，再以 `offset` + `limit` 讀取必要範圍；確認某行是否存在用 Grep，不必 Read。

---

## Windows 路徑格式

Bash 中統一使用 `/c/Users/<username>/` 前綴（依實際帳號替換）。

---

## Observation Masking

工具結果超過 2000 字元時，系統會自動將內容外部化為暫存檔（`~/.claude/obs-cache/`），context 中只保留路徑摘要：

```
[觀測結果已外部化至暫存檔：~/.claude/obs-cache/Read_xxx.txt，共 N 行 / M 字元。若需完整內容，請用 Read 工具讀取該路徑。]
```

- 看到上述摘要時，若任務需要完整內容，主動用 `Read` 工具讀取該路徑
- 若任務只需部分資訊（如確認某行是否存在），可直接根據摘要推斷
- 暫存檔 30 天後自動清除
