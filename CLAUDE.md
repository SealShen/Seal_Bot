# MyClaw 專案

此專案是 MyClaw Telegram Bot 的程式碼本體。

---

## Git Push 安全規範

Git push 前須通過安全掃描，詳細步驟見全域設定：

> `agent_global_configs/CLAUDE.md` → **Git Push 前強制安全掃描**

掃描由 `PreToolUse(Bash)` hook 自動攔截執行，無需手動呼叫。
發現問題時 hook 會列出清單並阻斷 push，須先修正再重新 commit 後 push。
