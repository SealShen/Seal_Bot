#!/usr/bin/env python3
"""AgentOpt-inspired task classifier for Claude Code model routing.

在 CLAUDE.md 中加入以下規則，讓 Claude 根據 [MODEL_ROUTER] 標籤分派模型：

  tier=haiku  → Agent(model="haiku") 執行任務本體，自己只做最終整合回覆
  tier=opus   → Agent(model="opus") 執行純推理部分（勿寫檔），自行整合輸出
  tier=sonnet → 正常自行處理（預設）
"""
import sys, json, re

data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
prompt = data.get("prompt", "").lower()

# 英文用 \b 字界；中文不加 \b（漢字間無空格，\b 不適用）
HAIKU_PATTERNS = [
    r'\b(show|list|find|search|grep|read|check)\b',
    r'(看|列出|找|搜尋|顯示|查看|讀取|找不到)',
    r'\b(typo|rename|format|indent|spacing)\b',
    r'(排版|重命名|改名|空格)',
    r'\b(run|execute|build|compile)\b',
    r'(執行|跑|編譯|安裝)',
    r'\b(what is|where is|how many)\b',
    r'(是什麼|在哪|有幾個|數一下)',
    r'\b(count|summarize)\b',
    r'(總結|統計|列舉)',
    r'\b(delete|remove)\b.{0,20}\b(line|file|comment)\b',
    r'(刪除|移除).{0,10}(檔|行|註解)',
]

CODEBASE_PATTERNS = [
    r'\b(neticrm|civicrm|php|tpl|hook|codebase|source code|repo)\b',
    r'(程式碼|原始碼|代碼庫|鉤子)',
]

ARCH_PATTERNS = [
    r'\b(architecture|module|structure|how it works|design|logic|flow|integration|inventory)\b',
    r'(架構|模組|設計意圖|怎麼實作|運作邏輯|流程設計|如何整合|盤點)',
    r'\b(where is|locate)\b',
    r'(在哪|定位)',
]

RECOVERY_PATTERNS = [
    r'(apologize|made a mistake|wrong|error occurred|failed to|not correct)',
    r'(抱歉|出錯|失敗|不正確|修正之前的|不對|不對勁|報錯)',
]

OPUS_PATTERNS = [
    r'\b(architect|system design|deep dive)\b',
    r'(系統設計|架構設計)',
    r'\brefactor the (entire|whole)\b',
    r'(重構整個|大規模重構)',
    r'\b(security audit)\b',
    r'(安全審計|漏洞分析|資安分析)',
    r'\b(algorithm design|data structure)\b',
    r'(演算法設計|資料結構)',
    r'\broot cause\b',
    r'(根本原因|深入分析)',
    r'\bperformance (bottleneck|profile)\b',
    r'(效能瓶頸|效能剖析)',
]

haiku_score = sum(1 for p in HAIKU_PATTERNS if re.search(p, prompt))
opus_score  = sum(1 for p in OPUS_PATTERNS  if re.search(p, prompt))
codebase_score = sum(1 for p in CODEBASE_PATTERNS if re.search(p, prompt))
arch_score     = sum(1 for p in ARCH_PATTERNS     if re.search(p, prompt))

# 掃描歷史紀錄中的失敗訊號（最近 4 則訊息）
messages = data.get("messages", [])
error_signals = 0
for m in messages[-4:]:
    m_content = str(m.get("content", "")).lower()
    if any(re.search(p, m_content) for p in RECOVERY_PATTERNS):
        error_signals += 1

# opus signal 但有寫檔意圖 → 維持 sonnet（Opus 有時跳過工具直接從記憶回答）
WRITE_SIGNALS = r'\b(write|create|add|implement|build|update|install|寫|建立|新增|實作|開發|更新|修改|寫入|覆寫|產生|產出|製作|安裝)\b'
has_write_intent = bool(re.search(WRITE_SIGNALS, prompt))

strategy = ""
if codebase_score >= 1 and arch_score >= 1:
    strategy = " strategy=use_deepwiki_first"

# 決定模型層級
if error_signals >= 2:
    tier, reason = "opus", "recovery_mode_triggered"
elif opus_score >= 1 and not has_write_intent and opus_score >= haiku_score:
    tier, reason = "opus", "deep_reasoning_no_write"
elif haiku_score >= 1 and opus_score == 0:
    tier, reason = "haiku", "mechanical_operation"
else:
    if strategy or error_signals >= 1:
        print(f"[MODEL_ROUTER] tier=sonnet reason=default{strategy}")
    sys.exit(0)

print(f"[MODEL_ROUTER] tier={tier} reason={reason}{strategy}")
