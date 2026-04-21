<!--
auto-generated: audit_baseline.py
generated: 2026-04-19T21:41:36+0800
source: past 14 days of ~/.claude/projects/*/*.jsonl
classifier: gemini-2.5-flash-lite
duration: 269s  classifier tokens: in=5552 out=1179
-->

# Audit Baseline: 使用情境分類（過去 14 天）

## 掃描結果

- 總掃描 prompts: **853**
- 成功分類: **90** (10.6%)
- 分類失敗（略過）: 763
- Classifier 耗時: 269s / token 消耗: in=5552 out=1179

## 分類分佈

| 類別 | 數量 | % | 可委派目標 | 平均長度 |
|------|------|-----|----------|---------|
| rewrite | 16 | 17.8% | → gemma_chat (Flash-Lite) | 85 chars |
| summarize | 1 | 1.1% | → gemma_chat (Flash-Lite) | 31 chars |
| search | 10 | 11.1% | → Haiku subagent | 26 chars |
| doc_mechanical | 7 | 7.8% | → gemma_chat (Flash-Lite) | 222 chars |
| code | 14 | 15.6% | ✗ Claude 自己處理 | 65 chars |
| analysis | 30 | 33.3% | ✗ Claude 自己處理 | 108 chars |
| other | 12 | 13.3% | ✗ Claude 自己處理 | 76 chars |

## 可委派總量

- **文字處理類**（rewrite + summarize + doc_mechanical）: **24** (26.7%)
- **搜尋類**（search）: **10** (11.1%)
- **合計可委派**: **34** (37.8%)

## 決策門檻提醒

- 整體可委派率: **37.8%** → ✅ > 15%，方案 B（Gemini 分類 hook）值得做
- 文字處理類單獨 26.7% ≥ 15% → 確認值得建 gate

## 各類別範例（各 3 筆）

### rewrite (16 筆)

- `[ad48f188]` _C:\Users\leond\Documents\My Digital Editions\誤判.epub 我想要把這個檔案送給notebookLLM 但_
- `[ad48f188]` _但返回"這份原始文本並非可閱讀的文章，而是 ePub 電子書檔案 遭逢編碼錯誤或直接以純文字模式開啟後所呈現的 二進位亂碼。內容包含了大量的系統符號與特殊字元，顯示出文件在讀取過程中，無法正確將數據轉換為人類語言文字。由於缺乏正確的 解碼途徑，目前完全無法從中獲取具體的資訊或主題細節。簡言之，這是一..._
- `[ad48f188]` _<task-notification> <task-id>be2jnd8al</task-id> <tool-use-id>toolu_01FR7nDUpvmFZM942mxhEhrE</tool-use-id> <output-file>C:\Users\leond\AppData\Local\T..._

### summarize (1 筆)

- `[65416a8b]` _請非常簡短的報告你的成果，讓我可以傳遞給另外一個session_

### search (10 筆)

- `[3c8ad5cd]` _很好 接著給我看neitivism專案中的各個專家設定檔_
- `[99557647]` _告訴我怎麼進行git clone_
- `[0893a50a]` _BOT有實作查詢session id的功能 請問在desk端該如何查詢_

### doc_mechanical (7 筆)

- `[3c8ad5cd]` _# 資安與隱私政策執行專家  你現在進入**資安與隱私政策執行專家**模式。  ## 角色  依據 Netivism ISMS 規範與個人資料安全維護計畫，協助執行： - MCP 設定稽核與憑證管理 - 資安政策查詢與合規確認 - Redmine 資安相關議題操作（依使用者指定）  ---  ## ..._
- `[30f39dfa]` _將所有會影響agent行為的指令檔與skill檔案統合成一個md檔案，讓我可以請其他LLM了解我們這邊claude code目前的架構與核心精神，但嚴禁包含機敏資料。_
- `[f839d6d4]` _wiki有寫到的部分，就不需要寫進claude.md_

### code (14 筆)

- `[3c8ad5cd]` _幫我在vscode打開這四個檔案_
- `[3c8ad5cd]` _google calandar的MCP也刪除_
- `[65416a8b]` _C:\Users\leond\.gemini\tmp\leond\525f06f2-23bc-4e9b-a116-3917a98bb30d\plans\file_organization_plan_for_agent.md   執行這個_

### analysis (30 筆)

- `[3c8ad5cd]` _請啟用資安專家。我們有讓客戶透過第三方導入金流，是提供第三方與我們聯名的申請表單 https://www.newpay.com.tw/forms/netivism 由於我們並不經手個資，表單是直接送給第三方，所以並沒有與第三方簽訂保密協議，請問這樣有符合相關規範嗎_
- `[3c8ad5cd]` _newpay只是協助進件申請藍新金流，並不需要PCI DSS_
- `[3c8ad5cd]` _其他供應商這該如何定義比較好，例如我們也有與科技濃湯合作優惠方案等等，但其實並沒有系統上的介接，要把所有合作組織納入有點困難_

### other (12 筆)

- `[3c8ad5cd]` _[Request interrupted by user for tool use]_
- `[3c8ad5cd]` _好，我已經刪除了 這樣以後不會載入了?_
- `[99557647]` _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_
