# MyClaw 專案

此專案是 MyClaw Telegram Bot 的程式碼本體。

---

## Git Push 安全規範

Git push 前須通過安全掃描，詳細步驟見全域設定：

> `agent_global_configs/CLAUDE.md` → **Git Push 前強制安全掃描**

掃描由 `PreToolUse(Bash)` hook 自動攔截執行，無需手動呼叫。
發現問題時 hook 會列出清單並阻斷 push，須先修正再重新 commit 後 push。

---

## 自動 Commit 機制（opt-in）

本 repo 根目錄存在 `.claude-auto-commit` 標記檔，觸發 `~/.claude/hooks/auto-commit.py`
在每次 `Edit` / `Write` 工具完成後自動 `git add` + `git commit` 該檔案。
Commit message 由 Gemma 根據 diff 產生，失敗則 fallback 為 `chore(<file>): auto-commit`。

- 關閉方式：刪除 `.claude-auto-commit`，或設定 `CLAUDE_AUTO_COMMIT_DISABLE=1`
- Dry-run：`CLAUDE_AUTO_COMMIT_DRY_RUN=1`（僅印訊息不 commit）
- Commit 只涵蓋當下變更的單一檔案，不會 `git add .`
- `.gitignore` 的檔案會被 `git check-ignore` 過濾掉

---

## Gemma 本地模型委派

Gemma 本地模型委派規則已移至全域設定：

> `agent_global_configs/CLAUDE.md` → **Gemma 本地模型委派**

MCP server 腳本位於本 repo `gamma-v1/mcp_gemma_server.js`，由 user-scope MCP 註冊後於所有 session 可用。
用量 log 寫入 `gamma-v1/gemma_usage.log`（因 `__dirname` 固定，跨專案呼叫自動匯總）。

---

## Haiku 搜尋委派（訂閱用戶版）

使用者是 Claude Pro/Max 訂閱用戶，**不是 API 付費用戶**。所以搜尋委派不走 Anthropic API，而是用 Claude Code 原生的 subagent 機制讓 Haiku 吃訂閱配額（消耗率遠低於 Opus）。

做法：`Agent` tool + `subagent_type: Explore` + `model: "haiku"` override。
- 不需要 API key
- 消耗訂閱配額，但 Haiku ≈ Opus 的 1/15（按官方 pricing 比例估）
- 0 新程式碼、0 新基礎設施

### 什麼任務該這樣委派
- 找檔案：`Glob` 類任務（pattern 明確、不需要理解程式碼）
- 找 symbol / keyword：`Grep` 類任務後做摘要
- 盤點資料夾結構：列出某目錄下有什麼
- 讀檔後抽取固定欄位：像 log 解析、config 列表

### 什麼任務**不要**委派
- 跨檔案邏輯推理（追 call graph、理解資料流）
- 需要 Write/Edit/Bash 的任何工作
- 架構判斷或多訊號整合
- 使用者明確點名要 Claude 回答的問題

### 使用範例
```
Agent({
  description: "Find bot entry file",
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Find the main Telegram bot entry file in my-lobster/. Report file path and the line where bot is initialized. Under 100 words."
})
```

### 觸發條件（強制）
當 `UserPromptSubmit` hook 輸出 `[MODEL_ROUTER] tier=haiku` 時，**優先用 `Agent(subagent_type="Explore", model="haiku", prompt=...)` 委派**，不要用主 session 直接 Glob/Grep。這條規則讓 route hook 的判斷真正發生效果，而不是只印字串。

### 量測（追蹤省幅，確保真的比較省）
- 全域 `PostToolUse` hook（`~/.claude/hooks/delegation_tracker.py`）會對每次 Agent tool call 寫一筆到 `~/.claude/delegation-usage.log`（JSONL）
- 欄位：`ts, session_id, subagent_type, model_override, prompt_chars, response_chars`
- 跑 `python ~/.claude/delegation-report.py` 輸出：依 model tier 分桶的呼叫次數、估算 token、counterfactual USD 省幅（假設不委派就全走 Opus）
- pricing 做 proxy：訂閱配額沒 per-call 計數，但消耗率比例和 API pricing 一致，所以 USD 估值雖非真實帳單，**方向與量級正確**
- 檢核目標：若 report 的 `Saved` 隨時間穩定增長、`Calls` haiku 桶佔比上升，代表委派機制有在運作

### 注意：曾有一個自建 Haiku MCP 被評估後刪除
- 曾短暫建過 `gamma-v1/haiku-search/`（MCP server + Anthropic SDK），但那個架構的省錢算法假設 Opus API 付費單價 $75/1M，**對訂閱用戶不適用**——反而是「花 API 錢省訂閱配額」方向錯誤
- 已整包刪除；`.mcp.json` 不要再加回 `haiku-search` entry
- 若將來真的開 Anthropic API 付費帳戶才重新評估

---

## Prompt Router 委派規則（強制）

`UserPromptSubmit` hook 會用 Gemma 對 user prompt 做意圖分類，輸出形如：

```
[PROMPT_ROUTER] subagent=<name> source=gemini:gemma-4-31b-it
```

**這是指令，不是建議。** 預設用 `Agent(subagent_type="<name>", ...)` 委派，**不要在主 session 直接處理**。

### 已註冊的自訂 subagent（`~/.claude/agents/*.md`）
- `lookup` — 純檢索（找檔案、找 symbol、列 issue）
- `research` — 多工具研究（codebase + deepwiki + redmine 三向）
- `think_deeply` — 設計討論／架構推理／取捨分析
- `complex_rewrite` — 複雜跨檔改寫
- `file_rewrite` — 單檔 atomic 改寫
- `root_cause` — 錯誤恢復與根因分析

### 跳過委派的條件（必須在回覆首句明寫原因）
只在以下情況可跳過：
1. **對話連續性關鍵**：多輪設計討論中途，subagent 看不到前文會掉訊息
2. **任務 trivial**：1-2 步驟可完成，委派 overhead 大於收益
3. **使用者明確點名要主 session 回答**

跳過時**回覆首句必須寫明**例如：「inline 處理因為對話連續性」。靜默跳過 = 違規。

### 為什麼要強制
- 主 session 對「委派成本」短視——直接答的 context 膨脹是延遲成本，不會被即時感知
- hook 已在 prompt_router_tracker（roadmap Fix C 待落地）追蹤遵從率，靜默跳過會被計入違規率
- 委派把答案壓成摘要回主 session，長對話下來省顯著 context
