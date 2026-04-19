"""distill.py — turn gemma_content.log into gemma_playbook.md using Gemma itself.

Strategy:
  1. Read recent successful entries from gemma_content.log (capped window).
  2. Truncate prompt/response per entry so the distillation call fits in context.
  3. Ask Gemma (via the same LM Studio endpoint) to synthesize a short playbook
     describing task patterns it has been used for, with do/don't guidance.
  4. Write the playbook atomically to gemma_playbook.md (temp file + rename).

Run standalone:
  python distill.py                # uses defaults
  python distill.py --limit 50     # only distill from last 50 entries
  python distill.py --dry-run      # print playbook to stdout, don't write

Designed to be called by auto_learn.py after idle_guard passes, but safe to run
manually too — the MCP server live-reads the playbook, no restart needed.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # gamma-v1/


def _load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()

CONTENT_LOG = ROOT / "gemma_content.log"
PLAYBOOK_PATH = ROOT / "gemma_playbook.md"
LMSTUDIO_BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
LMSTUDIO_MODEL = os.environ.get("LMSTUDIO_MODEL", "local-model")
LMSTUDIO_API_KEY = os.environ.get("LMSTUDIO_API_KEY", "")

MAX_ENTRIES = 60               # cap entries fed to distillation
MAX_PROMPT_CHARS_PER_ENTRY = 300
MAX_RESPONSE_CHARS_PER_ENTRY = 300
DISTILL_TIMEOUT_SECONDS = 300
DISTILL_MAX_TOKENS = 1800

META_SYSTEM_PROMPT = """你是 Gemma 在自我反思。請關閉 Chain-of-Thought / thinking 模式，直接給出答案。
你剛剛被提供一批過去被 Claude Code 委派執行過的任務記錄 (prompt + 你的 response)。
你的任務：為未來的「自己」寫一份簡短的 playbook（繁體中文），會被當作 system prompt 前綴自動注入。

playbook 必須：
- 總長度 ≤ 1500 字
- 結構使用 Markdown 標題
- 涵蓋以下區段：
  1. ## 常見任務類型 — 條列 3–6 種被委派的任務 pattern（抽象化，不要列原始 prompt）
  2. ## 做得好的模式 — 什麼風格的 response 過去被接受、簡潔、命中要點
  3. ## 要避免的陷阱 — 過去 response 中出現的問題（冗長、偏題、多餘前言、誤用 CoT 等）
  4. ## 回覆風格守則 — 4–6 條明確的執行指引，例如「直接輸出結果，不要說『好的』」
- 最後一行固定寫：`<!-- playbook generated at: <ISO-8601 時間> -->`

禁止：
- 不要在 playbook 中揭露原始 prompt 內容（隱私）
- 不要加引言、不要解釋你在做什麼
- 不要開啟 thinking 模式
"""


def read_entries(limit: int):
    if not CONTENT_LOG.exists():
        return []
    lines = CONTENT_LOG.read_text(encoding="utf-8", errors="ignore").splitlines()
    rows = []
    for line in lines[-limit * 3:]:  # read more than limit in case of bad lines
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    rows = [r for r in rows if r.get("prompt") and r.get("response")]
    return rows[-limit:]


def truncate(s: str, n: int) -> str:
    s = s.replace("\r", "").strip()
    if len(s) <= n:
        return s
    return s[: n // 2] + f"\n...[truncated {len(s) - n} chars]...\n" + s[-n // 2 :]


def build_corpus_prompt(entries):
    blocks = []
    for i, e in enumerate(entries, 1):
        p = truncate(e["prompt"], MAX_PROMPT_CHARS_PER_ENTRY)
        r = truncate(e["response"], MAX_RESPONSE_CHARS_PER_ENTRY)
        blocks.append(f"### 記錄 {i}\nPROMPT:\n{p}\n\nRESPONSE:\n{r}")
    joined = "\n\n".join(blocks)
    return (
        f"以下是過去 {len(entries)} 次委派記錄。請依據 system 指示產出 playbook。\n\n"
        f"{joined}\n\n"
        f"請現在輸出 playbook，從 `## 常見任務類型` 開頭，不要有任何前言。"
    )


def call_gemma(prompt: str, system: str):
    url = LMSTUDIO_BASE_URL.rstrip("/") + "/chat/completions"
    body = {
        "model": LMSTUDIO_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": DISTILL_MAX_TOKENS,
        "stream": False,
    }
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if LMSTUDIO_API_KEY:
        headers["Authorization"] = f"Bearer {LMSTUDIO_API_KEY}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=DISTILL_TIMEOUT_SECONDS) as r:
        resp = json.loads(r.read().decode("utf-8"))
    msg = (resp.get("choices") or [{}])[0].get("message", {}) or {}
    content = msg.get("content") or msg.get("reasoning_content") or ""
    return content.strip(), resp.get("usage") or {}


def write_atomic(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=MAX_ENTRIES)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    entries = read_entries(args.limit)
    if not entries:
        print(json.dumps({"ok": False, "reason": "no content log entries yet"}))
        sys.exit(2)

    prompt = build_corpus_prompt(entries)
    t0 = time.time()
    try:
        playbook, usage = call_gemma(prompt, META_SYSTEM_PROMPT)
    except Exception as e:
        print(json.dumps({"ok": False, "reason": f"gemma call failed: {e}"}))
        sys.exit(3)
    dt = time.time() - t0

    if not playbook:
        print(json.dumps({"ok": False, "reason": "gemma returned empty playbook"}))
        sys.exit(4)

    # Strip any model-written timestamp footer (it hallucinates dates)
    # and replace with real current time.
    import re
    playbook = re.sub(r"\n*<!--\s*playbook generated at:[^>]*-->\s*$", "", playbook).rstrip()
    playbook += f"\n\n<!-- playbook generated at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')} -->\n"

    if args.dry_run:
        print(playbook)
    else:
        write_atomic(PLAYBOOK_PATH, playbook)

    print(json.dumps({
        "ok": True,
        "entries_used": len(entries),
        "latency_seconds": round(dt, 2),
        "playbook_chars": len(playbook),
        "usage": usage,
        "wrote": None if args.dry_run else str(PLAYBOOK_PATH),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
