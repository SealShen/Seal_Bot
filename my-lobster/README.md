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

### 3. 建立 .env 設定檔

複製範例並填入真實值：

```bat
copy .env.example .env
notepad .env
```

`.env` 內容說明：

```ini
TELEGRAM_TOKEN=1234567890:ABCdef...     # BotFather 給你的 Token
MY_TELEGRAM_USER_ID=987654321           # 你的 User ID（數字）
CLAUDE_WORKING_DIR=C:\Users\你\Projects # Claude 執行時的工作目錄
```

### 4. 手動啟動測試

雙擊 `start_bot.bat`，或在終端機執行：

```bat
start_bot.bat
```

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
