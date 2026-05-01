# MyClaw 專案

此專案是 MyClaw Telegram Bot 的程式碼本體。

> 全域規則（Git Push 安全掃描 / Gemma 委派 / Prompt Router / Worktree gate）集中於
> `agent_global_configs/CLAUDE.md`，由對應 hook 自動執行。

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

## Gemma MCP server 位置

- 腳本：`gamma-v1/mcp_gemma_server.js`（user-scope MCP 註冊，所有 session 可用）
- 用量 log：`gamma-v1/gemma_usage.log`（`__dirname` 固定，跨專案呼叫自動匯總）

---

## Haiku 搜尋委派（訂閱用戶版）

使用者是 Pro/Max 訂閱用戶（非 API 付費）。搜尋類任務用
`Agent(subagent_type="Explore", model="haiku", prompt=...)` 委派，吃訂閱配額不走 API
（Haiku ≈ Opus 1/15 消耗）。

**該委派**：Glob/Grep 類查找、目錄盤點、log/config 固定欄位抽取。
**不該委派**：跨檔邏輯推理、Write/Edit/Bash、架構判斷、使用者明確點名 Claude 回答。

**觸發（強制）**：`UserPromptSubmit` hook 輸出 `[MODEL_ROUTER] tier=haiku` 時，主
session 不要直接 Glob/Grep，改委派 Explore agent。

**歷史**：曾短暫建過 `gamma-v1/haiku-search/`（MCP + Anthropic SDK），但對訂閱用戶是
「花 API 錢省訂閱配額」方向錯誤，已整包刪除；`.mcp.json` 不要再加回 `haiku-search`。
