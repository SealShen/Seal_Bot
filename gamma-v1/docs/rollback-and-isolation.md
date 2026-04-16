# Rollback 與隔離說明

## 隔離設計

gamma-v1 系統與現有工具的隔離方式：

| 層面 | 隔離方式 |
|------|---------|
| 程式碼 | 獨立目錄 `gamma-v1/`，不修改 `my-lobster/` 任何現有檔案 |
| 設定 | `.env` 放在 `gamma-v1/` 內，不碰全域設定或 `my-lobster/.env` |
| 日誌 | `gamma-v1/logs/audit.jsonl`，獨立存放 |
| Bot | 只新增 `/gamma` 指令，不修改現有訊息流程 |
| Git | `my-lobster/` 有自己的 git repo，snapshot 操作只在它內部 |

### 我可以安全地刪除整個 gamma-v1/ 嗎？

**可以。** 刪除 `gamma-v1/` 目錄不會影響：
- `my-lobster/bot.js`（現有 bot 流程）
- `my-lobster/.env`（現有憑證）
- 任何 Claude Code session 或設定

---

## Snapshot 機制

### 觸發條件

每次 profile 為 `implementer` 或 `architect` 且 executor 為 `local_claude_code` 時，在執行前自動呼叫 `hooks/pre_snapshot.js`。

### 快照類型

| 類型 | 條件 | Rollback 方式 |
|------|------|--------------|
| `git-stash` | 目錄有 git + 有未提交變更 | `git stash pop` |
| `git-head` | 目錄有 git + 工作樹乾淨 | `git reset --hard <SHA>` |
| `no-git` | 目錄無 git repo | 記錄時間戳，需手動回退 |

### 快照記錄在哪裡？

執行完成後的 audit log（`logs/audit.jsonl`）記錄了快照的 `type` 和 `ref`：

```jsonl
{"ts":"2026-04-16T10:00:00.000Z","event":"snapshot","snapType":"git-stash","snapRef":"stash@{0}","workDir":"C:\\Users\\leond\\MyClaw\\my-lobster"}
```

---

## 手動 Rollback 步驟

### 情況 1：快照類型 `git-stash`

```bash
cd C:\Users\<username>\MyClaw\my-lobster

# 確認 stash 存在
git stash list

# 恢復
git stash pop
```

如果 stash 不是最頂層（有多個），用名稱恢復：
```bash
# 查找正確的 stash（看 myclaw-snap: 前綴）
git stash list

# 用索引恢復
git stash pop stash@{1}
```

### 情況 2：快照類型 `git-head`

```bash
cd C:\Users\<username>\MyClaw\my-lobster

# 從 audit log 找到 ref（SHA）
node C:\Users\<username>\MyClaw\gamma-v1\bin\myclaw.js --log | grep snapshot

# 強制回退
git reset --hard <SHA>
```

### 情況 3：快照類型 `no-git`

沒有 git 保護。建議：
- 在執行前手動備份（`cp -r <dir> <dir>.bak`）
- 或在目錄中初始化 git：`git init && git add . && git commit -m "init"`

---

## 正式 Commit 流程

gamma-v1 不自動提交。完成任務後，你確認結果正確，再手動 commit：

```bash
cd C:\Users\<username>\MyClaw\my-lobster

# 確認變更
git diff
git status

# 確認後提交
git add <changed files>
git commit -m "feat: <description>"
```

---

## 緊急還原（最後手段）

如果 stash pop 或 reset 失敗：

```bash
cd C:\Users\<username>\MyClaw\my-lobster

# 查看所有 stash
git stash list

# 查看某個 stash 的內容（不 apply）
git stash show -p stash@{0}

# 建立新 branch 後 apply，保護主幹
git checkout -b recovery
git stash apply stash@{0}
```

---

## git worktree 進階隔離（可選）

若需要更強隔離（同時保留主幹），可用 git worktree：

```bash
cd C:\Users\<username>\MyClaw\my-lobster

# 建立隔離工作樹
git worktree add ../my-lobster-gamma-work -b gamma-task

# 在隔離目錄執行 gamma 任務
node C:\Users\<username>\MyClaw\gamma-v1\bin\myclaw.js --dir C:\Users\<username>\MyClaw\my-lobster-gamma-work <task>

# 確認結果後 merge 或 cherry-pick
git -C ../my-lobster-gamma-work log --oneline -5

# 清除工作樹
git worktree remove ../my-lobster-gamma-work
```
