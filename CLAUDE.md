# MyClaw 專案

此專案是 MyClaw Telegram Bot 的程式碼本體。

---

## Git Push 安全規範

Git push 前須通過安全掃描，詳細步驟見全域設定：

> `agent_global_configs/CLAUDE.md` → **Git Push 前強制安全掃描**

掃描由 `PreToolUse(Bash)` hook 自動攔截執行，無需手動呼叫。
發現問題時 hook 會列出清單並阻斷 push，須先修正再重新 commit 後 push。

---

## Gemma 本地模型委派（MCP）

本專案註冊了 `gemma-local` MCP server（見 `.mcp.json`），暴露 `gemma_chat`、`gemma_health`、`gemma_stats` 三個 tool，接到本機 LM Studio 的 Gemma。
目的是把**低風險、機械化、不需要跨訊號判斷**的子任務分派給本地模型，節省 Claude token 消耗。

### 什麼任務該丟給 `gemma_chat`
- 純文字改寫：摘要、翻譯、語氣/格式調整、條列轉散文或反之
- 機械式抽取：從一段文字挑關鍵字、標題、日期、URL
- 簡單分類或標註：情感、是/否、語系判斷、短標籤
- 模板填空：給定欄位值 → 產生固定樣板輸出

### 什麼任務**不要**委派，自己做
- 程式碼產生、修改、除錯
- 架構設計、多檔案影響分析、工具呼叫規劃
- 需要讀取檔案/repo 上下文、需要工具鏈串接的任何工作
- 使用者明確點名要 Claude 回答的問題

### 使用原則
1. 先用 `gemma_health` 確認可達（失敗就自己做，別卡住）
2. Prompt 要自含——Gemma 看不到本 session 上下文
3. 回傳尾端會附 `[gemma usage: ... latency=... model=...]` 方便追蹤節省量
4. 若 Gemma 輸出品質不佳，直接自己重做，不要連續重試

### 量測機制
- 每次 `gemma_chat` 成功/失敗會寫一筆到 `gamma-v1/gemma_usage.log`（JSONL，不入 git）
- `gemma_stats` tool 可隨時查總量：總呼叫數、總 completion tokens、以 Sonnet 4.6 `$15/1M` output 單價估的節省金額
- 檢核目標：若 `estimated_usd_saved_vs_sonnet` 隨時間穩定增長，代表委派機制有在運作；若近乎零，代表 Claude 幾乎沒叫 Gemma，需要重新審視任務性質或 CLAUDE.md 指引
