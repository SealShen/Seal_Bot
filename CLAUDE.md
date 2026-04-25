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

#### 存放：單一來源原則（2026-04-20 起）

基於憑證架構稽核（`Netivism/Claude/output/security/mcp_audit_20260420_credential_storage.md`），所有 API Key / Token / Secret 一律走下列單一來源：

- **Windows 使用者環境變數**（`HKCU\Environment`）為主要儲存
- 僅當 MCP server 內建 dotenv loader 時，可以 `.env` 檔作單一來源（如 `MyClaw/my-lobster/.env`、`MyClaw/gamma-v1/.env`）

**禁止在任何配置檔出現明文憑證：** `.mcp.json`、`~/.claude.json` 的 `mcpServers[*].env`、`settings.json`、`.gemini/extensions/**/gemini-extension.json`、以及 `*.config.*`、`settings.local.*`。

**若配置檔必須宣告 env**（例如 Gemini CLI 自動 redact `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/*AUTH*/*CREDENTIAL*` pattern，需顯式宣告才會傳入 MCP 子程序）：
- 僅允許 `${VAR_NAME}`（跨平台）或 `%VAR_NAME%`（Windows）引用形式
- 實際值永遠留在 OS env 單一來源

**對帳機制：** `C:/Users/leond/Netivism/Claude/scripts/check-keys.ps1` 掃描 OS env 存在性，以及六個注入層的明文殘留：`.claude/settings.local.json`（最高優先）、`.mcp.json`、`~/.claude.json`、`redmine-mcp/server.js` fallback、MyClaw `.mcp.json`、`gemini-extension.json`。修改 MCP / extension 配置後跑一次對帳；Key 輪替前後各跑一次（見下方 SOP）。

#### 輪替：Key Rotation SOP

任何 Key / Token 需要輪替時，照下列順序執行，確保不殘留舊值：

1. **跑 check-keys.ps1**（baseline）——確認目前哪些層有值
2. **在服務端產新 key**（Redmine / Transifex 後台）——先產，不廢舊
3. **更新 OS user env**（`HKCU\Environment`）——唯一要寫入的地方
4. **清除其他層殘留**——check-keys.ps1 `[2/6]`～`[6/6]` 若有 `[FAIL]`，手動清除對應檔案的 env 區塊
5. **重啟整個 VSCode**——`settings.local.json` 啟動時快取，重開 panel 無效，必須關整個 VSCode 再開
6. **再跑 check-keys.ps1**——確認 OS env OK + 其他所有層空白
7. **廢止舊 key**——確認新 key 可用（MCP 回 200）後才廢，避免輪替空窗

#### 接觸：禁止讀取、列印、對外使用

- **禁止** 讀取、列印或傳輸任何 `.env`、`.pem`、`.key`、`.p12` 等憑證檔案內容
- **禁止** 透過 `process.env` 或環境變數取得含 KEY、TOKEN、SECRET、PASSWORD 的值並對外使用
- **禁止** 執行 `printenv` 或類似指令列出完整環境變數

**此規則對所有執行主體生效**：主 session、Agent subagent（Explore/general-purpose/Plan 等）、MCP tool、hook 執行緒，一律適用。

#### 委派任務給子 agent 時

- Prompt 中 **禁止出現** `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL`、`.env` 等字樣作為搜尋目標
- 要理解專案組態，只描述「找出主配置的結構與入口檔名」「回報使用了哪些外部服務（用服務名稱如 Gemini、Telegram）」，不要求提取欄位值
- 若任務不可避免要碰設定檔，明確在 prompt 中註明：「**禁止讀取 .env 檔內容，只看結構與其他非機密檔**」

#### 意外讀到憑證

- **立即停止摘要與回報**，不在 summary 中引用（即使部分遮罩也不可）
- 告知使用者「讀到憑證，已中止」，由使用者決定下一步（輪換 / 清 transcript）

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

## Prompt Router subagent 指派

全域 UserPromptSubmit hook `~/.claude/hooks/prompt_router.py` 可能在 user prompt 開頭附加：

```
[PROMPT_ROUTER] subagent=<type> source=<s>
[PROMPT_ROUTER] delegate=gemma_chat source=<s>
```

### 收到 `subagent=<type>` 時（參考）

Router hint **僅供參考**，不強制 type match。自行讀任務描述判斷是否開 subagent、用哪一型。

**根據**：2026-04-25 合規回測，router type match 僅 0-33%，但 Claude 自選的型別通常更合適；以工具呼叫數為基礎的 threshold 也有循環矛盾（正確開 subagent 會讓 main context 工具數變低，無法當訊號）。所以判斷權留給 LLM 讀任務描述，hint 僅當參考。

**何時主動開 subagent**（保護 main context、節省 token）：
- 需要探索未知的多個模組/檔案（搜尋範圍不明確）
- 多個獨立子問題可平行處理
- 預期產生大量工具呼叫或長輸出
- 連續失敗 ≥ 2 次的除錯（用 `root_cause`）

反之，任務描述清晰、範圍明確、輸出短的請求，直接在主對話處理。

可用 subagent 型別參考：

| subagent_type    | 使用時機                              |
|------------------|--------------------------------------|
| `lookup`         | 定位檔案、函式、issue、wiki 頁         |
| `research`       | 跨模組調查、架構理解                  |
| `think_deeply`   | 設計討論、取捨分析、架構決策           |
| `complex_rewrite`| 多步驟改寫、含 Redmine 工具的任務      |
| `file_rewrite`   | 單一檔案格式或結構調整                |
| `root_cause`     | 連續失敗診斷、環境問題定位             |

呼叫規則（決定 spawn 時）：
1. Agent prompt 以 user 原始 prompt（去掉 `[PROMPT_ROUTER]` 前綴）為核心
2. 加入足夠的 session 上下文（相關路徑、已知資訊）讓 subagent 可獨立執行
3. 若 `[PROMPT_ROUTER]` 帶 `strategy=use_deepwiki_first`，在 Agent prompt 中明確指示優先使用 deepwiki

### 收到 `delegate=gemma_chat` 時

**必須先呼叫 `mcp__gemma-local__gemma_chat` 工具處理**，不得直接自己輸出答案。流程：

1. **先委派**：用 user prompt 原文（或重新組織後的清晰版本）呼叫 gemma_chat
2. **驗收輸出**：評估 Gemma 回傳的品質。品質不佳的判準：
   - 明顯偏離 user 要求（答非所問）
   - 技術術語被誤改（例：`會員管理` 被改成 `使用者管理`）
   - 遺漏 user 提供的關鍵資訊
   - 格式錯誤無法使用
3. **採用或拒絕**：
   - **品質可接受** → 直接將 Gemma 輸出呈現給 user（可加簡短前言）
   - **品質不佳** → 你自己重做，並寫一筆 rejection log 到 `~/.claude/routing-rejections.log`（JSONL）：
     ```bash
     python3 -c "import json,time; open('C:/Users/leond/.claude/routing-rejections.log','a',encoding='utf-8').write(json.dumps({'ts':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'router_verdict':'<rewrite|summarize|doc_mechanical>','reject_reason':'<簡短描述>','claude_redid':True},ensure_ascii=False)+'\n')"
     ```

例外（可不委派）：user 明確說「你自己做」；gemma_chat 呼叫失敗（記錄後自己做）；classifier 誤判為純文字任務但實際需跨檔案理解（寫 rejection，reason=`mis-classified`）。

檢討：每週跑 `python3 ~/.claude/hooks/routing_report.py` 查看委派率、rejection 率、省下 tokens；rejection 率連兩週 > 30% 需調 gate。

---

## Gemma 本地模型委派

`gemma-local` MCP server（user scope）暴露 `gemma_chat`、`gemma_health`、`gemma_stats` 三個 tool，接到本機 LM Studio 的 Gemma。
目的是把**低風險、機械化、不需要跨訊號判斷**的子任務分派給本地模型，節省 Claude token 消耗。
（搭配 Prompt Router 的 `delegate=gemma_chat` 使用。）

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
3. **Prompt 開頭固定加**：「請關閉 Chain-of-Thought / thinking 模式，直接給出答案。」
   原因：Gemma 4 支援 CoT 推理，但委派任務皆為機械化短任務，開啟 CoT 只會浪費 token 與增加延遲。
4. 回傳尾端會附 `[gemma usage: ... latency=... model=...]` 方便追蹤節省量
5. 若 Gemma 輸出品質不佳，直接自己重做（rejection 記錄見上方 Prompt Router 段），不要連續重試

### 量測機制
- 每次 `gemma_chat` 成功/失敗會寫一筆到 `C:/Users/leond/MyClaw/gamma-v1/gemma_usage.log`（JSONL，不入 git）
- 跨專案呼叫都會寫入同一份 log（MCP 腳本 `__dirname` 固定指向 MyClaw/gamma-v1），自然匯總所有 session 的委派量
- `gemma_stats` tool 可隨時查總量：總呼叫數、總 completion tokens、以 Sonnet 4.6 `$15/1M` output 單價估的節省金額
- 檢核目標：若 `estimated_usd_saved_vs_sonnet` 隨時間穩定增長，代表委派機制有在運作；若近乎零，代表 Claude 幾乎沒叫 Gemma，需要重新審視任務性質或 CLAUDE.md 指引

---

## Bash 長輸出歸檔

當**預期 bash 輸出會長、且之後可能需要回查**（例如 build log、test 輸出、長 git log），改用 `python C:/Users/leond/.claude/hooks/bash_summarize.py --cmd "..."` 而非直接 Bash。

原理：工具把 raw stdout/stderr 歸檔到 `%TEMP%\claude\bash_summary\bash_<ts>_<hash>.log` 並回傳檔案路徑；當前 turn 看到完整輸出照常處理，後續 turn 若要回查該輸出**直接 Read 檔案路徑**（不必重跑 bash）。這能在長 session 中避免重覆執行耗時命令、也保留細節做跨 turn 對照。

反例：短輸出、一次性命令、不打算回查 — 直接 Bash 即可。

**注意**：該工具原本還有 Gemini CLI 摘要路徑，但 2026-04-21 因 CLI 延遲 45-60s+ parked。目前預設行為只是歸檔 + passthrough，不壓縮 context。

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

