# Claude Code Telegram Bot

從手機透過 Telegram 遠端控制 Windows 電腦上的 Claude Code。

---

## 快速開始

### 1. 取得必要資訊

| 需要什麼 | 從哪裡取得 |
|---|---|
| Bot Token | 在 Telegram 找 **@BotFather**，傳 `/newbot` |
| 你的 User ID | 在 Telegram 找 **@userinfobot**，傳任意訊息 |

### 2. 安裝 Python 套件

在 `my-lobster/` 資料夾內執行：

```bat
:: 建議使用虛擬環境（可選）
python -m venv .venv
.venv\Scripts\activate

:: 安裝依賴
pip install -r requirements.txt
```

### 3. 設定環境變數（Windows 使用者變數）

敏感欄位建議存放在 Windows 使用者環境變數，不寫在 `.env`。

| 變數名稱 | 值 |
|---|---|
| `TELEGRAM_TOKEN` | BotFather 給的 Bot Token |
| `MY_TELEGRAM_USER_ID` | 你的 Telegram User ID（數字） |
| `TOTP_SECRET` | 首次啟動前**不必設**，見 Step 5 |

設定方式：

1. `Win + S` 搜尋「**編輯帳戶的環境變數**」並開啟
2. 在「**使用者變數**」區塊點「**新增**」，填入名稱與值，確定
3. 重複直到 `TELEGRAM_TOKEN` / `MY_TELEGRAM_USER_ID` 都設定好
4. **關閉所有現有 terminal / VSCode**（環境變數更新後只有新啟動的 process 才讀得到）

### 4. 建立 .env 設定檔

複製範例並填入非敏感欄位：

```bat
copy .env.example .env
notepad .env
```

`.env` 內只需填入工作目錄相關欄位：

```ini
CLAUDE_WORKING_DIR=C:\Users\你\Projects   # Claude 執行時的工作目錄
ALLOWED_DIRS=C:\Users\你\OtherProject     # 額外允許目錄（分號分隔，可空）
DIR_LABELS=OtherProject                   # 對應的顯示標籤（分號分隔）
BOT_OWNER_NAME=你的暱稱                   # TOTP QR code 顯示標籤
```

> `dotenv` 預設 `override: false` — 若 `.env` 與環境變數同名欄位並存，**環境變數優先**。

### 5. 首次啟動 + TOTP 設定

1. 雙擊 `start_bot.bat` 首次啟動
2. `bot.js` 偵測到無 `TOTP_SECRET`，會**自動產生並寫入 .env**
3. 在 Telegram 傳 `/setup` → 用 Google Authenticator 掃描 QR code
4. 傳 `/auth <6 位數碼>` 確認可用
5. 打開 `.env`，把 `TOTP_SECRET=xxx` 那行的值複製 → 到 Windows 環境變數新增 `TOTP_SECRET`
6. **刪除 `.env` 裡那行** `TOTP_SECRET=...`
7. 重啟 Bot（關掉現有 Bot 程序、重跑 `start_bot.bat`）

> ⚠️ **TOTP_SECRET 警示**：若之後不小心清掉 Windows 環境變數 `TOTP_SECRET`，下次 Bot 啟動會偵測到沒值、**自動產生新 secret 寫回 .env** → Google Authenticator 的舊驗證碼會失效，必須重跑 `/setup` 掃新 QR code。環境變數請妥善保管。

### 6. 驗證

Bot 啟動後，在 Telegram 傳 `/start` 確認連線成功。

---

## 使用方式

| 操作 | 效果 |
|---|---|
| 直接傳文字 | 交給 `claude --print <訊息>` 執行 |
| 傳送文字檔／程式碼 | 儲存到工作目錄，再讓 claude 處理 |
| 傳檔案時加上 Caption | Caption 作為 prompt，搭配檔案路徑一起傳給 claude |
| `/cancel` | 中止目前執行中的 claude 指令 |

執行期間每 **3 秒**會自動更新一次輸出，不需等全部跑完。

---

## 設定開機自動啟動（工作排程器）

> 這樣開機後 Bot 就會在背景自動執行，不需手動啟動。

### 方法 A：使用 GUI（推薦新手）

1. 按 `Win + S` 搜尋「**工作排程器**」並開啟
2. 右側點「**建立基本工作**」
3. 填入名稱，例如：`Claude Code Telegram Bot`
4. 觸發程序選「**電腦啟動時**」
5. 動作選「**啟動程式**」
6. 程式/指令碼填入（根據實際路徑調整）：
   ```
   C:\Users\<username>\MyClaw\my-lobster\start_bot.bat
   ```
7. 勾選「**開啟內容對話方塊…**」→ 完成後在「**一般**」頁籤勾選「**不管使用者是否登入都執行**」並勾選「**以最高權限執行**」
8. 確認並輸入 Windows 密碼

### 方法 B：使用命令列（一行搞定）

以**系統管理員**身分開啟 PowerShell，執行（路徑請自行調整）：

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Users\<username>\MyClaw\my-lobster\start_bot.bat"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "ClaudeCodeTelegramBot" `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Highest -Force
```

### 驗證自動啟動

重新開機後，在 Telegram 傳 `/start` 給 Bot，若收到回應即表示成功。

### 停用自動啟動

```powershell
Unregister-ScheduledTask -TaskName "ClaudeCodeTelegramBot" -Confirm:$false
```

---

## 安全說明

- 白名單機制：Bot 只接受 `MY_TELEGRAM_USER_ID` 指定的使用者訊息，其他人的訊息一律靜默忽略
- 敏感欄位（`TELEGRAM_TOKEN` / `MY_TELEGRAM_USER_ID` / `TOTP_SECRET`）建議存放在 Windows 使用者環境變數，不寫在 `.env`（.env 為明文檔、不加密）
- 請勿將 `.env` 檔案上傳到 Git（預設應在 `.gitignore` 中排除）

---

## 常見問題

**Q：Bot 沒有回應？**
- 確認 Bot Token 正確
- 確認 `MY_TELEGRAM_USER_ID` 填的是你自己的 ID
- 確認網路連線正常

**Q：出現 `` `claude` 指令找不到 ``？**
- 確認 Claude Code 已安裝：在終端機執行 `claude --version`
- 若使用虛擬環境，確認 Claude Code 安裝在系統 PATH，而非虛擬環境內

**Q：輸出太長被截斷？**
- Telegram 單則訊息上限 4096 字元，Bot 會自動截取最後 3800 字元
- 可以改用檔案方式傳回（未來功能）

**Q：如何更改工作目錄？**
- 修改 `.env` 中的 `CLAUDE_WORKING_DIR`，重啟 Bot 即生效
