# /review-flow — Guarded review → fix → test → commit-with-trailer → push

你正在執行一個有 guard 的工作流：所有要 push 的 commits 必須先經過 review 與測試。本指令是配合 `agent_global_configs/hooks/git-push-guard.py` Layer 1（review marker 檢查）設計，目的是**讓 push 之前的 review/test 流程顯式化**。

**全程強制每步等使用者確認**，禁止短路。

---

## Step 1：判定 review 範圍

如果使用者在 `/review-flow` 後接了引數，當作 PR 號碼處理（呼叫 `gh pr view <num>` + `gh pr diff <num>`）。

否則：

```bash
git log @{u}..HEAD --oneline
```

- 0 commits → 回報「無 unpushed commits，沒有要 review 的東西」並停止
- ≥1 commits → 列出來，這就是 review 範圍

---

## Step 2：執行 review

對每個 commit（或 PR diff）做 code review，**輸出格式對齊 `/review`**：

- **Overview**：這個 commit 做什麼
- **🔴 Bugs / risks**：按嚴重度排序，每個含 `file:line` + Why + Fix
- **🟡 Style / 小事**：列出但不強制
- **🟢 做得好的地方**（簡短）

重點：每個 fix 建議要**具體**——`file:line` + 確切字串、不要含糊。

---

## Step 3：跟使用者對齊修改範圍

問使用者：

> 要採納哪些修法？
> - `全部` → 套用所有 🔴 fixes
> - `編號` (e.g. `1,3`) → 只套用指定的
> - `none` → 跳過修改，直接到 Step 6（補 trailer）
> - `自己改` → 暫停，等使用者說「改完了」

等使用者回應，**不要自己決定**。

---

## Step 4：套用 fixes + syntax/lint check

依 Step 3 的選擇用 Edit 套用修改。每個被改的檔案跑 syntax/lint：

| 副檔名 | 檢查方式 |
|---|---|
| `.js` | `node --check <file>`（exit ≠ 0 = fail）|
| `.ps1` | `powershell -NoProfile -Command "$null = [scriptblock]::Create((Get-Content '<file>' -Raw))"`（純 parse，不執行）|
| `.py` | `python -m py_compile <file>` |
| `.json` | `python -c "import json,sys; json.load(open(sys.argv[1]))" <file>` |
| 其他 | 跳過，註明「無 static check」 |

任一個失敗 → 報告錯誤，**回到 Step 3 重新決定**（讓使用者選要不要改、改別的、或 abort）。

---

## Step 5：手動測試 checklist

依被改的檔案類型，產生**針對性**的 checklist。原則：**不要列無關的測試**。

| 改了什麼 | 引導使用者測 |
|---|---|
| `bot.js` | 「請按 TG 🔄 重啟，發測試訊息看回應正常」**禁止 Claude 自動重啟 bot**（見 `feedback_bot_restart.md`）|
| `bot_wrapper.ps1` | 「`Stop-Process -Id <wrapper PID> -Force`，等 ≤ 1 分鐘看 task scheduler 是否拉回；確認 `bot_wrapper.death.log` 新增 WRAPPER_START」|
| `~/.claude/hooks/*.py` 或 `agent_global_configs/hooks/*.py` | 「觸發該 hook 的事件，看 hook 輸出 / log 是否符合預期」|
| `~/.claude/commands/*.md` | 「跑 `/<command-name>` 確認流程順暢」|
| Python script (一次性) | 「跑該 script 確認 exit 0 + 輸出符合預期」|
| 純文件 (`*.md` 無附帶程式碼) | 「跳過手動測試」|
| 其他 | 問使用者「合理的驗證方式是什麼」|

印出 checklist，問：

> 測試結果？(`ok` / `fail <說明>` / `skip`)

- `skip` → trailer 寫 `Test-status: skipped`
- `fail` → 帶著失敗訊息回到 Step 3
- `ok` → 繼續

---

## Step 6：Commit with review trailer

**情境分流**：

### A. Step 4 有改檔案
```bash
git add <changed files>
git commit -m "<conventional title>" \
  -m "<body：簡述 fixes 與 why>" \
  --trailer "Reviewed-by: claude-opus-4-7" \
  --trailer "Tested-by: manual-checklist" \
  --trailer "Test-status: <passed|skipped>" \
  --trailer "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
（用 `--trailer` 而非多個 `-m`，避免每個 trailer 各自成段違反 git trailer 規範）

Commit message body 應該總結 review 重點（這就是「review 重點記錄到 commit」）。

### B. Step 3 選 `none`，但既存 unpushed commits 沒有 `Reviewed-by:` trailer
跟使用者確認後 amend 最近一個 commit 補 trailer：
```bash
git commit --amend --no-edit \
  --trailer "Reviewed-by: human" \
  --trailer "Test-status: skipped"
```

> ⚠️ amend 會改 commit hash，若該 commit 已 push 到別人會看到的 branch 要先警告使用者。

### C. 沒有需要動的（既存 commits 已有 trailer）
直接到 Step 7。

---

## Step 7：Push

```bash
git push
```

`git-push-guard.py` 會跑：
1. **Layer 1（review marker）**：剛加好 trailer → 通過
2. **Layer 2（security scan）**：路徑/token/email/機敏副檔名

可能結果：

- ✅ push 成功 → 回報 branch 名 + 上游
- ❌ Layer 2 阻擋 → **原樣呈現 hook 訊息給使用者**，不要自作主張 bypass。若使用者看完判斷是 false positive，他可以手動加 `# noscan` 重跑。
- ❌ 網路 / 認證錯誤 → 回報 git 原始錯誤，停下等使用者處理

---

## 全流程鐵則

1. **每步等使用者確認**（Step 3、4 lint 後、5 測試結果、6 commit 前、7 push 前）——禁止把多步打包跑
2. **禁止自動重啟 bot**（見 `feedback_bot_restart.md`）——只能提示按 🔄
3. **禁止 echo `.env` 或任何 credential 值**（見 `feedback_credentials_handling.md`）
4. **使用者可隨時暫停**（見 `feedback_bidirectional_pause.md`）；Claude 卡住時要顯性回報，不偽裝進展
5. **禁用 `# noreview` bypass**——這條 flag 只給 hook 認，`/review-flow` 內部不該主動建議使用者用這個逃生艙
6. **測試 fail 時回 Step 3，不要硬上 commit**
