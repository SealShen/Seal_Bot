# MyClaw gamma-v1 架構說明

## 概覽

gamma-v1 是一套「單一入口、多 executor」的本機 AI 路由系統，掛在現有 MyClaw / Telegram Bot 之上，不破壞原有穩定環境。

```
使用者
 ├── Telegram Bot (my-lobster/bot.js) → /gamma <task>
 └── CLI (gamma-v1/bin/myclaw.js)    → node bin/myclaw.js <task>
                        │
                        ▼
               ┌─────────────────┐
               │  index.js       │  ← 總排程入口
               │  1. classify    │
               │  2. route       │
               │  3. policy      │
               │  4. snapshot    │
               │  5. execute     │
               │  6. audit       │
               └────────┬────────┘
               ┌─────────┴──────────┐
               │                    │
    ┌──────────▼──────────┐  ┌──────▼──────────────────┐
    │ local_gamma4        │  │ local_claude_code        │
    │ adapters/           │  │ adapters/                │
    │ lmstudio_client.js  │  │ claude_code_runner.js    │
    │ (LM Studio HTTP)    │  │ (spawn `claude` CLI)     │
    └─────────────────────┘  └──────────────────────────┘
```

---

## 檔案結構

```
gamma-v1/
├── index.js                  ← 主路由引擎
├── package.json
├── .env                      ← 複製自 .env.example，不進 git
├── .env.example
├── adapters/
│   ├── lmstudio_client.js    ← LM Studio OpenAI-compatible adapter
│   └── claude_code_runner.js ← 本機 Claude Code CLI wrapper
├── router/
│   ├── task_classifier.js    ← 規則式 profile 分類
│   ├── route_profile.js      ← profile → executor + read-only 映射
│   └── policy.js             ← 安全 denylist + 確認閘道
├── hooks/
│   ├── pre_snapshot.js       ← 寫入前 git stash 快照
│   └── audit_log.js          ← 追加寫入 logs/audit.jsonl
├── bin/
│   ├── myclaw.js             ← 主 CLI（含 flag 解析）
│   ├── run-gamma4.js         ← 快速 LM Studio 捷徑
│   └── run-claude-code.js    ← 快速 Claude Code 捷徑
├── logs/
│   └── audit.jsonl           ← 自動產生的稽核日誌
└── docs/
    ├── architecture-v1.md    ← 本文件
    ├── usage-v1.md
    └── rollback-and-isolation.md
```

---

## Profile 路由表

| Profile       | 預設 Executor     | Read-only | 需要 Snapshot | 典型任務        |
|---------------|-------------------|-----------|---------------|-----------------|
| `explorer`    | `local_gamma4`    | 是        | 否            | 查詢、解釋、搜尋 |
| `implementer` | `local_claude_code` | 否      | 是            | 新增、修改、修復 |
| `architect`   | `local_gamma4`    | 否        | 是（若改檔）  | 設計、規劃、比較 |
| `security`    | `local_gamma4`    | 是        | 否            | 安全稽核、漏洞查詢 |

---

## 升級建議 (suggestUpgrade)

- `explorer` 結果過短 → 建議升至 `architect`
- `architect` 執行失敗 → 建議升至 `implementer`
- 使用者可以 `--profile <new>` 重新執行

---

## Policy 層（安全）

三層防護：

1. **Hard block** — 任何 `.env/.key/.pem`、系統目錄、憑證環境變數存取：直接拒絕
2. **Read-only gate** — `explorer`/`security` profile 若有寫入關鍵字：拒絕
3. **Confirm gate** — 危險操作（`rm -rf`、force push 等）：回傳 `needsConfirm:true`，等待明確 `--yes`

與 `my-lobster/bot.js` 的安全規則互相對稱，不重複不衝突。

---

## Executor 細節

### local_gamma4 (LM Studio)
- 呼叫 `http://localhost:1234/v1/chat/completions`（或 env 設定的 `LMSTUDIO_BASE_URL`）
- 不消耗任何外部 token
- 適合探索型、只讀、快速草稿

### local_claude_code
- `spawn('claude', ['--print', '--output-format', 'stream-json', ...])`
- 沿用已登入訂閱，不走 API key
- 適合實作、改檔、工具協作

---

## 稽核日誌欄位

每條日誌（JSONL）包含：

| 欄位 | 說明 |
|------|------|
| `ts` | ISO 8601 時間戳 |
| `event` | `task_start` / `task_end` / `blocked` / `needs_confirm` / `snapshot` |
| `profile` | 使用的 profile |
| `executor` | 呼叫的 executor |
| `readOnly` | 是否只讀模式 |
| `snapshot` | 快照型別與 ref |
| `ok` | 執行是否成功 |
| `latencyMs` | 執行耗時 |
| `error` | 錯誤訊息（如有） |
| `sessionId` | Claude Code session ID（如有） |
