"""audit_baseline.py — one-time classification audit of past 14-day user prompts.

Classifies real user text prompts (not tool-results) via Gemini Flash-Lite batched,
into delegation categories. Produces audit_baseline.md for methodology review.

Run:
  python audit_baseline.py            # full run (~5 min)
  python audit_baseline.py --sample 100  # smaller sample for smoke test
  python audit_baseline.py --dry-run  # extract only, no classification
"""
import argparse
import json
import os
import re
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

def _load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

_load_dotenv()

BASE = os.environ.get("GOOGLE_AI_BASE_URL", "http://localhost:1234/v1").rstrip("/")
KEY = os.environ.get("GOOGLE_AI_API_KEY", "")
# Classification uses the fast short-task model (Flash-Lite by default)
MODEL = os.environ.get("GOOGLE_AI_MODEL", "gemini-2.5-flash-lite")

PROJECTS = Path.home() / ".claude" / "projects"
OUT = ROOT / "audit_baseline.md"

DAYS = 14
BATCH_SIZE = 15
MIN_CHARS = 15
MAX_CHARS_FOR_CLASSIFIER = 500
SLEEP_BETWEEN_CALLS = 8.0  # conservative — free tier RPM bursts out at ~10 in practice
REQUEST_TIMEOUT = 60
RETRY_BACKOFFS = [20, 45, 90]  # seconds — retry 429/503 with exponential pause

CATEGORIES = ["rewrite", "summarize", "search", "doc_mechanical", "code", "analysis", "other"]
DELEGATABLE_TEXT = {"rewrite", "summarize", "doc_mechanical"}
DELEGATABLE_SEARCH = {"search"}

CLASSIFIER_SYSTEM = """你是一個任務分類器。每個 prompt 只能歸屬一個類別。類別定義：

- rewrite: 使用者提供自己寫的文字，要求改寫、潤飾、調整語氣/格式、翻譯
- summarize: 要求摘要指定檔案、資料庫查詢結果、文章、log 等已存在的內容
- search: 單純搜尋檔案、函式名、關鍵字，不需理解程式邏輯
- doc_mechanical: 機械化文檔處理（格式轉換、模板填空、抽關鍵字、清單轉散文、表格轉 markdown）
- code: 程式碼生成、修改、除錯、重構、測試撰寫
- analysis: 架構設計、跨檔案邏輯推理、多訊號整合判斷、策略討論
- other: 問答、閒聊、確認指令、不屬於以上任一類

輸出格式：只輸出 JSON 陣列，不要任何其他文字、說明或思考過程。
格式：[{"id":1,"cat":"rewrite"},{"id":2,"cat":"code"},...]
"""


def extract_prompts():
    cutoff = time.time() - DAYS * 86400
    prompts = []
    for path in PROJECTS.glob("*/*.jsonl"):
        if "subagents" in path.parts:
            continue
        try:
            if path.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        sid = path.stem[:8]
        proj = path.parent.name
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if obj.get("type") != "user":
                        continue
                    c = (obj.get("message") or {}).get("content")
                    if isinstance(c, str):
                        text = c
                    elif isinstance(c, list):
                        text = "\n".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
                    else:
                        continue
                    text = re.sub(r"<ide_[^>]+>.*?</ide_[^>]+>", "", text, flags=re.DOTALL)
                    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL)
                    text = re.sub(r"<command-[^>]+>.*?</command-[^>]+>", "", text, flags=re.DOTALL)
                    text = text.strip()
                    if len(text) < MIN_CHARS:
                        continue
                    # Skip system-generated pseudo-user messages (not real prompts)
                    if text.startswith("<local-command-caveat>") or text.startswith("Caveat:"):
                        continue
                    if text == "[Request interrupted by user]":
                        continue
                    # Skip outlier huge pastes (likely skill/doc dumps, not real prompts)
                    if len(text) > 10000:
                        continue
                    prompts.append({
                        "ts": obj.get("timestamp", ""),
                        "session": sid,
                        "project": proj,
                        "text": text,
                        "len": len(text),
                    })
        except OSError:
            continue
    return prompts


def classify_batch(batch):
    numbered = "\n---\n".join(
        f"[{i}] {p['text'][:MAX_CHARS_FOR_CLASSIFIER]}"
        for i, p in enumerate(batch, 1)
    )
    user_msg = f"請分類以下 {len(batch)} 個 prompts：\n\n{numbered}\n\n直接輸出 JSON 陣列。"
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": CLASSIFIER_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.1,
        "max_tokens": 600,
        "stream": False,
    }
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = f"Bearer {KEY}"
    data = json.dumps(body).encode()
    resp = None
    last_err = None
    for attempt, backoff in enumerate([0] + RETRY_BACKOFFS):
        if backoff:
            time.sleep(backoff)
        try:
            req = urllib.request.Request(BASE + "/chat/completions", data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                resp = json.loads(r.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code not in (429, 500, 502, 503, 504):
                return [None] * len(batch), 0, 0, last_err
        except Exception as e:
            last_err = str(e)
    if resp is None:
        return [None] * len(batch), 0, 0, last_err

    msg = (resp.get("choices") or [{}])[0].get("message", {})
    content = msg.get("content") or ""
    usage = resp.get("usage") or {}
    in_tok = usage.get("prompt_tokens", 0)
    out_tok = usage.get("completion_tokens", 0)

    # Extract JSON array from content (model may wrap with ```json or extra text)
    m = re.search(r"\[\s*\{.*?\}\s*\]", content, re.DOTALL)
    if not m:
        return [None] * len(batch), in_tok, out_tok, "no-json-found"
    try:
        arr = json.loads(m.group(0))
    except Exception as e:
        return [None] * len(batch), in_tok, out_tok, f"json-parse: {e}"

    cats = [None] * len(batch)
    for item in arr:
        if not isinstance(item, dict):
            continue
        idx = item.get("id")
        cat = item.get("cat")
        if isinstance(idx, int) and 1 <= idx <= len(batch) and cat in CATEGORIES:
            cats[idx - 1] = cat
    return cats, in_tok, out_tok, None


def build_report(prompts, results, total_in, total_out, duration_s):
    by_cat = Counter()
    len_by_cat = defaultdict(list)
    samples_by_cat = defaultdict(list)
    unknown = 0

    for p, cat in zip(prompts, results):
        if cat is None:
            unknown += 1
            continue
        by_cat[cat] += 1
        len_by_cat[cat].append(p["len"])
        if len(samples_by_cat[cat]) < 3:
            excerpt = p["text"][:150].replace("\n", " ")
            samples_by_cat[cat].append(f"- `[{p['session']}]` _{excerpt}{'...' if p['len']>150 else ''}_")

    classified = sum(by_cat.values())
    total = len(prompts)
    text_delegate = sum(by_cat[c] for c in DELEGATABLE_TEXT)
    search_delegate = sum(by_cat[c] for c in DELEGATABLE_SEARCH)
    total_delegatable = text_delegate + search_delegate

    lines = []
    lines.append("<!--")
    lines.append(f"auto-generated: audit_baseline.py")
    lines.append(f"generated: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}")
    lines.append(f"source: past {DAYS} days of ~/.claude/projects/*/*.jsonl")
    lines.append(f"classifier: {MODEL}")
    lines.append(f"duration: {duration_s:.0f}s  classifier tokens: in={total_in} out={total_out}")
    lines.append("-->\n")
    lines.append("# Audit Baseline: 使用情境分類（過去 14 天）\n")

    lines.append("## 掃描結果\n")
    lines.append(f"- 總掃描 prompts: **{total}**")
    lines.append(f"- 成功分類: **{classified}** ({classified*100/total:.1f}%)")
    lines.append(f"- 分類失敗（略過）: {unknown}")
    lines.append(f"- Classifier 耗時: {duration_s:.0f}s / token 消耗: in={total_in} out={total_out}")
    lines.append("")

    lines.append("## 分類分佈\n")
    lines.append("| 類別 | 數量 | % | 可委派目標 | 平均長度 |")
    lines.append("|------|------|-----|----------|---------|")
    for cat in CATEGORIES:
        n = by_cat[cat]
        pct = n * 100 / max(classified, 1)
        avg_len = sum(len_by_cat[cat]) / len(len_by_cat[cat]) if len_by_cat[cat] else 0
        target = "→ gemma_chat (Flash-Lite)" if cat in DELEGATABLE_TEXT \
                 else "→ Haiku subagent" if cat in DELEGATABLE_SEARCH \
                 else "✗ Claude 自己處理"
        lines.append(f"| {cat} | {n} | {pct:.1f}% | {target} | {avg_len:.0f} chars |")
    lines.append("")

    lines.append("## 可委派總量\n")
    lines.append(f"- **文字處理類**（rewrite + summarize + doc_mechanical）: **{text_delegate}** ({text_delegate*100/max(classified,1):.1f}%)")
    lines.append(f"- **搜尋類**（search）: **{search_delegate}** ({search_delegate*100/max(classified,1):.1f}%)")
    lines.append(f"- **合計可委派**: **{total_delegatable}** ({total_delegatable*100/max(classified,1):.1f}%)")
    lines.append("")

    lines.append("## 決策門檻提醒\n")
    pct_total = total_delegatable * 100 / max(classified, 1)
    pct_text = text_delegate * 100 / max(classified, 1)
    if pct_total < 5:
        verdict = "❌ 整體可委派 < 5%，不值得建 gate（收益低於實作與維護成本）"
    elif pct_total < 15:
        verdict = "🟡 5-15% 區間，建議方案 A（regex hook 零成本）"
    else:
        verdict = "✅ > 15%，方案 B（Gemini 分類 hook）值得做"
    lines.append(f"- 整體可委派率: **{pct_total:.1f}%** → {verdict}")
    if pct_text >= 15:
        lines.append(f"- 文字處理類單獨 {pct_text:.1f}% ≥ 15% → 確認值得建 gate")
    lines.append("")

    lines.append("## 各類別範例（各 3 筆）\n")
    for cat in CATEGORIES:
        samples = samples_by_cat.get(cat, [])
        if not samples:
            continue
        lines.append(f"### {cat} ({by_cat[cat]} 筆)\n")
        lines.extend(samples)
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=0, help="classify only N random prompts")
    parser.add_argument("--dry-run", action="store_true", help="extract only, no classification")
    args = parser.parse_args()

    print(f"[1/3] Scanning JSONL ({DAYS} days)...", flush=True)
    prompts = extract_prompts()
    print(f"      Extracted {len(prompts)} real user prompts")

    if args.sample and args.sample < len(prompts):
        import random
        random.seed(42)
        prompts = random.sample(prompts, args.sample)
        print(f"      Sampled to {len(prompts)} prompts")

    if args.dry_run:
        print("[dry-run] skipping classification.")
        return

    print(f"[2/3] Classifying via {MODEL} (batch={BATCH_SIZE}, sleep={SLEEP_BETWEEN_CALLS}s)...", flush=True)
    results = [None] * len(prompts)
    total_in = total_out = 0
    t0 = time.time()
    n_batches = (len(prompts) + BATCH_SIZE - 1) // BATCH_SIZE

    for bi in range(n_batches):
        start = bi * BATCH_SIZE
        batch = prompts[start:start + BATCH_SIZE]
        cats, in_tok, out_tok, err = classify_batch(batch)
        for i, c in enumerate(cats):
            results[start + i] = c
        total_in += in_tok
        total_out += out_tok
        filled = sum(1 for c in cats if c)
        elapsed = time.time() - t0
        eta = elapsed / (bi + 1) * (n_batches - bi - 1)
        status = f"      [{bi+1}/{n_batches}] ok={filled}/{len(batch)}"
        if err:
            status += f" ERR={err[:40]}"
        status += f"  (elapsed {elapsed:.0f}s, ETA {eta:.0f}s)"
        print(status, flush=True)

        if bi < n_batches - 1:
            time.sleep(SLEEP_BETWEEN_CALLS)

    duration = time.time() - t0

    print(f"[3/3] Writing report to {OUT}...", flush=True)
    report = build_report(prompts, results, total_in, total_out, duration)
    OUT.write_text(report, encoding="utf-8")
    print(f"      Done. Classifier usage: in={total_in} out={total_out} tokens ({duration:.0f}s)")


if __name__ == "__main__":
    main()
