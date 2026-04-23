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

### Step 3：在 ~/.claude.json 加入 placeholder

讀取 `~/.claude.json`，在 `env` 區塊加入：

```json
"{ENV_VAR_NAME}": "REPLACE_WITH_YOUR_TOKEN"
```

若 `env` 區塊不存在則新增。

### Step 4：告知使用者

輸出以下訊息：

```
完成。請用文字編輯器開啟：
  ~/.claude.json

將 "{ENV_VAR_NAME}" 的值從 "REPLACE_WITH_YOUR_TOKEN" 改為真實 Token。

存檔後重啟 Claude Code，再告訴我，我幫你測試連線。
```

---

## 注意事項

- **禁止**要求使用者在對話中貼出真實 Token
- **禁止**讀取或顯示 `~/.claude.json` 中 Token 的實際值
- 每個新服務獨立一份稽核紀錄，不合併
