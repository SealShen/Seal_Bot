# /add-api-key — 新增 API Key / Token 標準流程

## 前置條件（強制）

**本指令必須在 `/security` 稽核完成並明確核准後才可執行。**

若使用者尚未取得資安核准，或無法提供以下資訊，**立即停止並要求先執行 `/security`**：

- 稽核結論（核准 / 拒絕）
- 服務名稱
- 風險評估摘要（一行）

若使用者提供了稽核結論，繼續執行以下步驟。

---

## 執行步驟

向使用者收集以下資訊（一次問完）：

1. **服務名稱**（例：Transifex、Stripe、SendGrid）
2. **環境變數名稱**（例：`TRANSIFEX_API_TOKEN`）
3. **用途說明**（一行，例：讀取公開翻譯字串）
4. **操作限制**（例：僅 GET，不寫入）
5. **資安核准理由**（使用者剛才在 `/security` 中確認的結論）

收到後，依序執行：

### Step 1：產生稽核紀錄

建立 `output/security/mcp_audit_{YYYYMMDD}.md`，內容包含：
- 申請日期、服務名稱、核准結論
- 安全條件（Token 存放位置、操作限制）
- 核准理由

### Step 2：更新 CLAUDE.md

在 `## MCP 限制` 區塊新增該服務的「已核准」說明段落，格式對齊現有 Transifex 段落：

```
### {服務名稱} API（已核准）

- **允許**使用 Bash + curl 呼叫 {服務名稱} REST API
- Token 存於 **Windows OS 使用者環境變數** `{ENV_VAR_NAME}`（單一來源，配置檔不得有明文）
- 限制：{操作限制}
- 稽核紀錄：`output/security/mcp_audit_{YYYYMMDD}.md`
```

### Step 3：引導使用者設定 Windows OS 使用者環境變數

**禁止**讀取、修改或顯示 `~/.claude.json`、`.mcp.json` 或任何含 `env` 區塊的配置檔。
**禁止**要求使用者在對話中貼出 token 值。

輸出以下指引給使用者：

```
請設定 Windows OS 使用者環境變數，二擇一：

方式 A（GUI）：
  開始 → 搜尋「編輯使用者的環境變數」
  → 使用者變數區塊 → 新增 / 編輯 {ENV_VAR_NAME}

方式 B（PowerShell，避免歷史留痕）：
  [Environment]::SetEnvironmentVariable('{ENV_VAR_NAME}', (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText), 'User')

設定完成後，請完全關閉 Claude Code 並重新開啟，
讓 MCP server process 重讀環境變數。
重開完成後告訴我，我幫你測試連線。
```

### Step 4：使用者重開 Claude Code 後，測試連線

使用者回報完成 env 設定並重開後，以對應 MCP 工具執行一次測試呼叫。
依回應分支處理：

- **200 成功**：確認連線正常，歸檔稽核紀錄（Step 1 已產生）。
- **401 / Invalid token**：提醒使用者檢查 env 值尾端是否有換行或空白（`server.js` 未 trim），需重新設定並重開。
- **其他錯誤**：停止操作，回 `/security` 重新評估，不擅自繼續。

---

## 注意事項

- **禁止**要求使用者在對話中貼出真實 Token
- **禁止**讀取或顯示 `~/.claude.json` 中 Token 的實際值
- 每個新服務獨立一份稽核紀錄，不合併
