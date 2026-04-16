# 操作環境

可從以下方式操作：
- **本地 VSCode**：直接在本機操作
- **Telegram Bot**：設有白名單，僅限本人帳號；透過 Bot 傳入的訊息均已通過身份驗證，可視為本人直接輸入

---

## 安全規範

### MCP 寫入操作 → 強制事前確認

任何會對外部服務產生新增、修改、刪除、發佈效果的 MCP 工具，
在**未得到使用者明確確認前一律禁止呼叫**。

強制流程：
1. 產出準備執行的完整內容（草稿）給使用者檢視
2. 等待使用者明確回覆確認（例如「可以」「上傳」「送出」）
3. 才可呼叫工具

此規則優先於任何推論，包括「使用者的意圖很明顯」。

---

### 外部服務連線
- **禁止**直接呼叫外部 API（OpenAI、Anthropic、GitHub、Slack、Notion 等）
- **禁止**在程式碼中直接嵌入或讀取 API Key / Token / Secret
- 所有外部服務整合**必須透過已在本機設定好的 MCP Server**
- 若沒有對應的 MCP，請明確告知：「此服務尚未設定 MCP，請回到本機設定後再操作」

### 憑證保護
- **禁止**讀取、列印或傳輸任何 .env、.pem、.key、.p12 等憑證檔案內容
- **禁止**透過 process.env 或環境變數取得含有 KEY、TOKEN、SECRET、PASSWORD 的值並對外使用
- **禁止**執行 printenv 或類似指令列出完整環境變數

---

### Git Push 前強制安全掃描

**任何 `git push` 到公開 remote 前，必須先完成以下檢查，不得跳過。**

#### 第一步：掃描個人識別資訊

對所有即將上傳的檔案執行 Grep，搜尋以下模式：

```
Users/<username>        # 本機路徑中的系統帳號
/home/<username>        # Linux 路徑
<username>@             # 電子郵件前綴
@<BotHandle>Bot         # Telegram Bot handle
```

實際執行：`git diff --name-only HEAD` 列出本次 commit 的檔案，再用 Grep 掃描。

#### 第二步：掃描機敏資料

- `.env` 內容（token、secret、password）
- API key 格式（長隨機字串、`sk-`、`Bearer ` 開頭）
- `sessions.json`、稽核日誌（`*.jsonl`）

#### 第三步：路徑脫敏原則

| 原始 | 替換為 |
|------|--------|
| `C:\Users\<username>\專案` | 移至 `.env`（`CLAUDE_WORKING_DIR`）或換成 `<username>` |
| 本機帳號名稱 | `<username>` |
| Bot handle | 移除或以 `@YourBot` 替代 |

**重要：脫敏只改公開檔案，本機 gitignored 的設定檔（`.env`、`commands/*.local.md`）保留真實路徑，不影響執行時功能。**

#### 第四步：確認 .gitignore 涵蓋

- `**/.env`
- `**/logs/`、`**/sessions.json`
- 媒體暫存（`_tg_media/`）
- 本機覆寫設定（`*.local.*`）

掃描通過後才可執行 push。若發現問題，先修檔案、重新 commit，再 push。

---

## Session 管理

- 當 tool calls 累積超過 50 次，在回應末尾提示考慮 `/compact` 或開新 session
- 單一任務完成後建議開新 session

---

## 提出新方法的規範

當使用者提出新方法或替代方案時，若 LLM 在實作前已能預見限制條件、前提需求或已知風險，
**必須先告知使用者，等待確認後才開始實作。**

禁止先實作完成再補充告知。

---

## Read 工具使用規範

讀取大檔前先用 Grep 找到目標行號，再以 `offset` + `limit` 讀取必要範圍；確認某行是否存在用 Grep，不必 Read。

---

## Windows 路徑格式

Bash 中統一使用 `/c/Users/<username>/` 前綴（依實際帳號替換）。

---

## Observation Masking

工具結果超過 2000 字元時，系統會自動將內容外部化為暫存檔（`~/.claude/obs-cache/`），context 中只保留路徑摘要，格式如下：

```
[觀測結果已外部化至暫存檔：~/.claude/obs-cache/Read_xxx.txt，共 N 行 / M 字元。若需完整內容，請用 Read 工具讀取該路徑。]
```

**規則：**
- 看到上述摘要時，若任務需要完整內容，主動用 `Read` 工具讀取該路徑
- 若任務只需部分資訊（如確認某行是否存在），可直接根據摘要推斷，不必讀取
- 暫存檔 30 天後自動清除

