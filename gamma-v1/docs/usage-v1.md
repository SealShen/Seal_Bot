# MyClaw gamma-v1 使用說明

## 1. 初次設定

```bash
cd C:\Users\<username>\MyClaw\gamma-v1

# 複製設定範本
cp .env.example .env
# 按需編輯 .env（LM Studio URL、模型名稱等）
```

`.env` 預設值：
```
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=local-model
LMSTUDIO_TIMEOUT=60000
CLAUDE_WORKING_DIR=C:\Users\<username>\MyClaw
```

---

## 2. 確認 LM Studio 運作中

```bash
node bin/myclaw.js --health
# [OK] LM Studio is reachable at http://localhost:1234/v1
```

如果失敗：
1. 開啟 LM Studio
2. 載入 gamma4（或任何模型）
3. 啟動本機伺服器（預設 port 1234）

---

## 3. CLI 使用

### 基本用法

```bash
# 自動 profile 分類（最常用）
node bin/myclaw.js 什麼是 MyClaw？

# 指定 profile
node bin/myclaw.js --profile explorer 解釋 bot.js 的架構
node bin/myclaw.js --profile implementer 修正 bot.js 第 50 行的 bug

# 強制指定 executor
node bin/myclaw.js --executor local_gamma4 比較兩種設計方案
node bin/myclaw.js --executor local_claude_code 新增 /status 指令

# 指定工作目錄
node bin/myclaw.js --dir C:\Users\<username>\MyClaw\my-lobster 列出所有指令
```

### 快速捷徑

```bash
# 強制走 LM Studio（便宜、快速）
node bin/run-gamma4.js 解釋這段程式碼的作用

# 強制走 Claude Code（可改檔）
node bin/run-claude-code.js 修正 bot.js 的 session 管理邏輯
```

### stdin 輸入

```bash
echo "請說明 MyClaw 的目錄結構" | node bin/myclaw.js
cat task.txt | node bin/myclaw.js --profile architect
```

---

## 4. 危險操作確認

若任務含有危險關鍵字（`rm -rf`、force push 等），系統會暫停並回傳：

```
[CONFIRM REQUIRED] ⚠️ 刪除檔案或目錄（不可回復）
Re-run with --yes to proceed.
```

確認要執行時加上 `--yes`：

```bash
node bin/myclaw.js --yes 刪除 /tmp/test 目錄
```

---

## 5. 查看稽核日誌

```bash
# 最近 20 筆（預設）
node bin/myclaw.js --log

# 最近 50 筆
node bin/myclaw.js --log 50
```

輸出格式：
```
2026-04-16T10:00:00.000Z  [task_start] profile=explorer  executor=local_gamma4
2026-04-16T10:00:01.500Z  [task_end]   profile=explorer  executor=local_gamma4
```

---

## 6. Telegram Bot 整合

在 Telegram 傳送：

```
/gamma 解釋 bot.js 的目前架構
/gamma --profile implementer 新增 /status 指令
/gamma --executor local_gamma4 比較兩種設計
```

Bot 會顯示路由結果（profile / executor）和執行輸出。

---

## 7. Profile 選擇指南

| 你想做的事 | 建議 profile |
|------------|-------------|
| 問問題、查資料、讀懂程式 | `explorer` |
| 新增功能、改 bug、重構 | `implementer` |
| 設計架構、評估方案、比較 | `architect` |
| 安全稽核、找漏洞 | `security` |

也可以在 prompt 中用 `[profile:xxx]` 強制指定：

```bash
node bin/myclaw.js "[profile:implementer] 幫我修復這個問題"
```

---

## 8. 常見問題

**LM Studio 沒回應？**
- 確認 LM Studio 已啟動並載入模型
- 確認 Server 在 port 1234 啟動
- 執行 `node bin/myclaw.js --health` 確認

**Claude Code 找不到？**
- 確認 `claude` 在 PATH 中：`claude --version`
- 確認已登入訂閱

**任務被 BLOCKED？**
- 查看 `node bin/myclaw.js --log` 中的 blocked 記錄
- 確認路徑在允許清單內，或不包含敏感關鍵字
