<!--
purpose: 供 analyze_sessions.py Section 3 前注入 Gemma prompt，
         告知已判斷過的訊號，避免重複產出被否決的建議。
maintained by: <username>（與 Claude 在 MyClaw session 內討論後更新）
update pattern: 每次 review _suggestions.md 並作出「採納 / 否決」判斷後，
                把新結論追加到對應區塊。
-->

# Analysis Anchors — 已判斷過的訊號清單

## 假警報（不要再當成新發現提出）

- **ToolSearch 高頻呼叫**（14 天 ~140 次）
  原因：Claude Code harness 的 deferred tool schema 懶載入機制，非 permission 或 memory 層問題，使用者不可配置。不要再建議「預載工具 schema」或「加進 allowlist」。
  判斷日期：2026-04-19

- **python vs python3 指令比例懸殊**（21:144）
  原因：兩者指向同一個 `/c/Users/<username>/AppData/Local/Microsoft/WindowsApps/python` → Python 3.14.3 binary，純粹是下指令風格差異，無環境不一致問題。
  判斷日期：2026-04-19

- **cat 指令高頻**（14 天 ~48 次）
  原因：Claude Code 內建指令已引導「優先 Read tool」；`settings.json` 已允許 `Bash(cat:*)` 無 permission 摩擦；多數情境為合法 piping（`cat file | xxx`）或使用者明確要求。不必再建議「改用 Read」。
  判斷日期：2026-04-19

- **ls/cd/find 高頻探索模式**
  原因：本質是 session 起始的環境建立節奏，是工作模式而非效率問題。已有 Haiku Agent 委派機制可處理真正長的探索；短單步探索直接做即可，過度切換反而浪費。不要再建議「建立起始快照」或「強制委派」。
  判斷日期：2026-04-19

## 已納入 memory（不要再建議加入，除非要替換/更新）

- **Netivism Redmine 工作流閉環**
  位置：`C:/Users/<username>/.claude/projects/c--Users-<username>-Netivism-Claude/memory/reference_redmine_workflow.md`
  入索引日期：2026-04-19

- **雙專案並行節奏（MyClaw 即時 / Netivism 批次）**
  位置：`C:/Users/<username>/.claude/projects/c--Users-<username>-MyClaw/memory/user_role.md`
  入索引日期：2026-04-19

- **Bot 改完需提醒使用者手動重啟**
  位置：`C:/Users/<username>/.claude/projects/c--Users-<username>-MyClaw/memory/feedback_bot_restart.md`

- **Claude Code CLI 模型切換需顯式 model ID**
  位置：`C:/Users/<username>/.claude/projects/c--Users-<username>-MyClaw/memory/feedback_explicit_model_ids.md`

## 架構備忘（分析時需意識到的前提）

- **gemma_chat 實際走 Gemini 為主、Gemma 為備**
  `gemma-v1/adapters/lmstudio_client.js` 主通道是 `gemini-2.5-flash-lite`（雲端），fallback 才是本地 `google/gemma-4-e4b`。`gemma_usage.log` 的呼叫大多數實際是 Gemini。統計「Gemma 委派節省」時要意識到這個雙層路由。
  記錄日期：2026-04-19

- **探索類任務（ls/find/grep/Glob）不可委派給 Gemma/Gemini**
  兩者皆為純文字 LLM，無 filesystem tool access。該由 Haiku Agent（`subagent_type=Explore, model=haiku`）處理。
  委派門檻：預計 ≥ 3 次 Bash 探索、或結果 > 2k tokens 會污染主 context。低於此直接做即可。

- **憑證檔案完全禁區**
  `.env`、`.pem`、`.key`、`.p12` 等不得讀取、列印、傳輸——此規則對主 session、Agent subagent、MCP tool 全面生效。詳見 `agent_global_configs/CLAUDE.md` 憑證保護段。分析建議時不得建議「讀 .env 驗證配置」這類動作。

## 保留觀察（暫不處理，下次分析時再看是否惡化）

- Haiku Agent 實際使用次數（14 天 ~37 次）相對 ls/find/grep 總頻次（~290 次）偏低
  觀察點：若下次分析 Haiku 使用率仍未提升，代表委派習慣沒跟上，考慮強化 `route_model.py` 的觸發條件或在 CLAUDE.md 加硬規。目前先不動。
