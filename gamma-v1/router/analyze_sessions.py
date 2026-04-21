"""analyze_sessions.py — daily 14-day Claude Code session analysis via Gemma.

Pipeline:
  1. Rule-based stats (Python): scan ~/.claude/projects/*/*.jsonl
  2. 5 sequential Gemma calls, each producing one section.
     Each call receives: stats summary + prompt samples + condensed prior sections.
  3. Incremental write to memory/_suggestions.md after each section.
  4. Progress checkpoint (.analyze_progress.json) — resume on partial failure.

Run:
  python analyze_sessions.py              # normal (respects daily gate)
  python analyze_sessions.py --force      # skip daily gate
  python analyze_sessions.py --resume     # force resume from checkpoint
  python analyze_sessions.py --dry-run    # stats only, skip Gemma
"""
import argparse
import json
import os
import re
import time
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # gamma-v1/

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

BASE = os.environ.get("GOOGLE_AI_BASE_URL", "http://localhost:1234/v1")
# ANALYZE_MODEL lets this CoT pipeline use a different (stronger) model than
# short-task delegation via mcp_gemma_server.js, while sharing the same endpoint.
MODEL = os.environ.get("ANALYZE_MODEL") or os.environ.get("GOOGLE_AI_MODEL", "local-model")
KEY = os.environ.get("GOOGLE_AI_API_KEY", "")
PROJECTS = Path.home() / ".claude" / "projects"
OUT = PROJECTS / "C--Users-<username>-MyClaw" / "memory" / "_suggestions.md"
PROGRESS_FILE = HERE / ".analyze_progress.json"
ANCHORS_FILE = HERE / "analysis_anchors.md"

DAYS = 14
GEMMA_TIMEOUT = 500
MAX_SAMPLES = 15
SAMPLE_CHARS = 120
CONDENSE_CHARS = 500  # max chars from prior section to pass forward


# ── Section definitions ────────────────────────────────────────────────────────

SECTIONS = [
    {
        "id": "s1",
        "heading": "## 1. 使用者工作模式觀察",
        "prompt": (
            "## 1. 使用者工作模式觀察\n"
            "根據以上統計與 prompt 取樣，分析使用者的職能定位、工作節奏、偏好工具使用方式。"
            "300字以內，具體，引用數字佐證。"
        ),
        "max_tokens": 1600,
    },
    {
        "id": "s2",
        "heading": "## 2. 重複出現的任務模式",
        "prompt": (
            "## 2. 重複出現的任務模式\n"
            "列出 3–5 種在 session prompt 與工具頻率中反覆出現的任務類型。"
            "每種格式：**模式名稱** — 描述（一句話）— 佐證證據（引用 prompt 編號或工具數字）。"
        ),
        "max_tokens": 1800,
    },
    {
        "id": "s3",
        "heading": "## 3. 建議加進 memory 的項目",
        "prompt": (
            "## 3. 建議加進 CLAUDE.md / memory 的項目\n"
            "根據前兩節的觀察，列出 3–5 條具體可寫進 memory 的建議。\n"
            "每條格式：\n"
            "- **建議類型**：user / feedback / project / reference\n"
            "- **標題**：\n"
            "- **內容**：（一到兩句話）\n"
            "- **理由**：（一句話，為什麼值得記）"
        ),
        "max_tokens": 2000,
    },
    {
        "id": "s4",
        "heading": "## 4. 工作流程優化機會",
        "prompt": (
            "## 4. 工作流程優化機會\n"
            "基於使用頻率與任務模式，列出 3–4 項具體可執行的自動化或 hook 機會。"
            "每項說明：現象 → 建議行動 → 預期效益。"
        ),
        "max_tokens": 2200,
    },
    {
        "id": "s5",
        "heading": "## 5. 風險觀察",
        "prompt": (
            "## 5. 風險觀察\n"
            "指出 2–3 項從數據可觀察到的潛在風險或效率瓶頸（如單點依賴、知識孤島、工具過度集中）。"
            "每項：現象描述 + 建議緩解方式。"
        ),
        "max_tokens": 1800,
    },
]


# ── Stats collection ───────────────────────────────────────────────────────────

def first_user_text(obj):
    if obj.get("type") != "user":
        return None
    c = (obj.get("message") or {}).get("content")
    if isinstance(c, str):
        text = c
    elif isinstance(c, list):
        text = "\n".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    else:
        return None
    text = re.sub(r"<ide_[^>]+>.*?</ide_[^>]+>", "", text, flags=re.DOTALL)
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL)
    text = re.sub(r"<command-[^>]+>.*?</command-[^>]+>", "", text, flags=re.DOTALL)
    return text.strip() or None


def collect_stats():
    cutoff = time.time() - DAYS * 86400
    files = []
    for p in PROJECTS.glob("*/*.jsonl"):
        if "subagents" in p.parts:
            continue
        try:
            if p.stat().st_mtime >= cutoff:
                files.append(p)
        except OSError:
            continue
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    sessions = user_msgs = asst_msgs = 0
    tool_uses, bash_cmds, per_project = Counter(), Counter(), Counter()
    first_prompts = []

    for path in files:
        sessions += 1
        proj = path.parent.name
        per_project[proj] += 1
        first_seen = False
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
                    t = obj.get("type")
                    if t == "user":
                        user_msgs += 1
                        if not first_seen:
                            text = first_user_text(obj)
                            if text:
                                ts = obj.get("timestamp", "")
                                first_prompts.append((ts, proj, text))
                                first_seen = True
                    elif t == "assistant":
                        asst_msgs += 1
                        c = (obj.get("message") or {}).get("content") or []
                        if isinstance(c, list):
                            for part in c:
                                if isinstance(part, dict) and part.get("type") == "tool_use":
                                    name = part.get("name") or "?"
                                    tool_uses[name] += 1
                                    if name == "Bash":
                                        cmd = (part.get("input") or {}).get("command", "")
                                        first = cmd.strip().split(None, 1)[0].lower() if cmd.strip() else ""
                                        if first:
                                            bash_cmds[first] += 1
        except OSError:
            continue

    return {
        "sessions": sessions,
        "user_msgs": user_msgs,
        "asst_msgs": asst_msgs,
        "tool_uses": tool_uses,
        "bash_cmds": bash_cmds,
        "per_project": per_project,
        "first_prompts": first_prompts,
    }


def build_stats_summary(stats):
    lines = [
        f"統計摘要（過去 {DAYS} 天）：",
        f"  sessions={stats['sessions']}  user_msgs={stats['user_msgs']}  asst_msgs={stats['asst_msgs']}",
        "  top projects: " + ", ".join(f"{p}({n})" for p, n in stats["per_project"].most_common(5)),
        "  top tools: " + ", ".join(f"{t}({n})" for t, n in stats["tool_uses"].most_common(8)),
        "  top bash: " + ", ".join(f"{c}({n})" for c, n in stats["bash_cmds"].most_common(8)),
    ]
    return "\n".join(lines)


def build_samples_text(stats):
    fp = stats["first_prompts"]
    if len(fp) <= MAX_SAMPLES:
        samples = fp
    else:
        sp = sorted(fp, key=lambda x: x[0])
        step = max(1, len(sp) // MAX_SAMPLES)
        samples = sp[::step][:MAX_SAMPLES]

    def trunc(s, n):
        s = s.replace("\r", "").strip()
        return s if len(s) <= n else s[:n] + f"...[+{len(s)-n}]"

    blocks = [f"[{i}] {ts[:10]} @{pr}\n{trunc(tx, SAMPLE_CHARS)}"
              for i, (ts, pr, tx) in enumerate(samples, 1)]
    return "\n\n".join(blocks)


def load_anchors():
    """Load analysis_anchors.md — already-judged signals that should filter out
    repeat false-positive suggestions. Returns '' if file missing or unreadable."""
    if not ANCHORS_FILE.exists():
        return ""
    try:
        content = ANCHORS_FILE.read_text(encoding="utf-8", errors="ignore")
        content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL).strip()
        return content
    except OSError:
        return ""


# ── Gemma call ─────────────────────────────────────────────────────────────────

REASONING_EFFORT = os.environ.get("ANALYZE_REASONING_EFFORT", "medium")  # low/medium/high for Gemini thinking budget


def call_gemma(prompt: str, max_tokens: int):
    url = BASE.rstrip("/") + "/chat/completions"
    # For thinking models (Gemini 2.5 Flash), max_tokens is a TOTAL budget shared
    # between reasoning tokens and the visible answer. Pad by 4× so thinking has
    # room without starving the final answer, then cap thinking via reasoning_effort.
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
        "max_tokens": max_tokens * 4,
        "stream": False,
        "reasoning_effort": REASONING_EFFORT,
    }
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = f"Bearer {KEY}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=GEMMA_TIMEOUT) as r:
        resp = json.loads(r.read().decode("utf-8"))
    dt = time.time() - t0
    msg = (resp.get("choices") or [{}])[0].get("message", {})
    content = msg.get("content") or msg.get("reasoning_content") or ""
    usage = resp.get("usage") or {}
    return content.strip(), usage, round(dt, 1)


# ── Progress checkpoint ────────────────────────────────────────────────────────

def load_progress():
    today = time.strftime("%Y-%m-%d")
    try:
        data = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
        if data.get("date") == today:
            return data
    except Exception:
        pass
    return {"date": today, "done": [], "condensed": {}}


def save_progress(prog):
    PROGRESS_FILE.write_text(json.dumps(prog, ensure_ascii=False), encoding="utf-8")


# ── Output writing ─────────────────────────────────────────────────────────────

def init_output(stats_summary):
    header = (
        "<!--\n"
        "auto-generated: gemma session analyzer\n"
        f"source: past {DAYS} days of transcripts\n"
        f"generated: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
        "pipeline: rule-based stats + Gemma segmented CoT (5 sections)\n"
        "status: suggestion-only - review manually before promoting to memory\n"
        "-->\n\n"
        f"{stats_summary}\n\n---\n\n"
        "# Gemma reflection\n\n"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(header, encoding="utf-8")


def append_section(heading, content):
    with OUT.open("a", encoding="utf-8") as f:
        f.write(f"{heading}\n\n{content}\n\n---\n\n")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="skip daily gate")
    parser.add_argument("--resume", action="store_true", help="resume from checkpoint")
    parser.add_argument("--dry-run", action="store_true", help="stats only, skip Gemma")
    args = parser.parse_args()

    prog = load_progress()
    today = time.strftime("%Y-%m-%d")

    # Daily gate: skip if already completed today (unless --force/--resume)
    if not args.force and not args.resume:
        if set(s["id"] for s in SECTIONS).issubset(set(prog["done"])):
            print(f"[skip] already completed today ({today}). Use --force to rerun.")
            return

    print(f"[1/2] Scanning sessions (last {DAYS} days)...")
    stats = collect_stats()
    print(f"      sessions={stats['sessions']} user_msgs={stats['user_msgs']} asst_msgs={stats['asst_msgs']}")

    stats_summary = build_stats_summary(stats)
    samples_text = build_samples_text(stats)
    anchors_text = load_anchors()
    if anchors_text:
        print(f"      loaded anchors ({len(anchors_text)} chars) — filtering known-judged signals")

    if args.dry_run:
        print(stats_summary)
        print(f"\n--- {len(stats['first_prompts'])} first prompts collected ---")
        return

    # Fresh output file only if starting from scratch
    if not prog["done"] or args.force:
        init_output(stats_summary)
        prog = {"date": today, "done": [], "condensed": {}}
        save_progress(prog)

    print(f"[2/2] Running {len(SECTIONS)} Gemma sections (CoT on)...")

    for sec in SECTIONS:
        sid = sec["id"]
        if sid in prog["done"] and not args.force:
            print(f"      [{sid}] already done, skipping")
            continue

        # Build cascading context from previous sections (condensed)
        prior_ctx = ""
        if prog["condensed"]:
            parts = []
            for prev_sec in SECTIONS:
                prev_id = prev_sec["id"]
                if prev_id == sid:
                    break
                if prev_id in prog["condensed"]:
                    parts.append(f"{prev_sec['heading']}\n{prog['condensed'][prev_id]}")
            if parts:
                prior_ctx = "\n\n以下是前幾節已完成的摘要（供參考）：\n\n" + "\n\n".join(parts) + "\n\n"

        anchors_block = ""
        if anchors_text:
            anchors_block = (
                f"## 分析基線（Analysis Anchors）\n"
                f"以下是使用者已判斷過的訊號。產出觀察與建議時**必須過濾掉這些**：\n"
                f"- 標為「假警報」的統計異常視為預期現象，不列為問題、不建議改善\n"
                f"- 標為「已納入 memory」的項目不再建議加入\n"
                f"- 「架構備忘」是分析時要知道的前提，引用時要正確\n"
                f"- 「保留觀察」項目只有在本次數據顯示惡化時才提，否則忽略\n\n"
                f"{anchors_text}\n\n"
            )

        prompt = (
            f"請關閉 Chain-of-Thought / thinking 模式，直接給出答案。不要在輸出中展示思考過程。\n\n"
            f"以下是使用者過去 {DAYS} 天 Claude Code 活動的統計與 session 取樣。\n\n"
            f"{stats_summary}\n\n"
            f"## Session 起始 prompt 取樣（共 {MAX_SAMPLES} 筆）\n"
            f"{samples_text}\n\n"
            f"{prior_ctx}"
            f"{anchors_block}"
            f"---\n\n"
            f"只輸出以下這一個區段（不要重複前面的內容，不要輸出思考過程）：\n\n"
            f"{sec['prompt']}\n\n"
            f"繁體中文，具體，不空泛。直接從標題開始輸出。"
        )

        t0 = time.time()
        print(f"      [{sid}] calling Gemma (max_tokens={sec['max_tokens']})...", end=" ", flush=True)
        try:
            content, usage, latency = call_gemma(prompt, sec["max_tokens"])
        except Exception as e:
            print(f"FAILED: {e}")
            print(f"      checkpoint saved at {sid}, resume with --resume")
            break

        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", "?")
        print(f"done ({latency}s, out={usage.get('completion_tokens')} reasoning={reasoning})")

        # Strip duplicate heading if Gemma echoed any ## heading at the start
        lines = content.lstrip().splitlines()
        if lines and lines[0].startswith("## "):
            content = "\n".join(lines[1:]).lstrip("\n")

        append_section(sec["heading"], content)

        # Condense for next section (first CONDENSE_CHARS chars, strip markdown noise)
        condensed = content[:CONDENSE_CHARS]
        prog["done"].append(sid)
        prog["condensed"][sid] = condensed
        save_progress(prog)

    done_count = len(prog["done"])
    total = len(SECTIONS)
    print(f"\nDone: {done_count}/{total} sections. Output: {OUT}")
    if done_count < total:
        print(f"Incomplete — re-run with --resume to continue from {SECTIONS[done_count]['id']}")


if __name__ == "__main__":
    main()
