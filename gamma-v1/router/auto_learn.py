"""auto_learn.py — orchestrator called by Task Scheduler.

Flow:
  1. Run idle_guard.py — exit quietly if gates not met.
  2. [Hourly] distill.py — refresh gemma_playbook.md when content log has grown.
  3. [Daily, ~2am] analyze_sessions.py — 5-section segmented Gemma analysis of
     14-day session transcripts. Writes to memory/_suggestions.md.
  4. All runs write JSONL audit to auto_learn.log.

Flags:
  --force      bypass idle_guard (still checks new-entries gate for distill)
  --force-all  bypass every gate

Review: Get-Content gamma-v1\\router\\auto_learn.log -Tail 20
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # gamma-v1/
CONTENT_LOG = ROOT / "gemma_content.log"
PLAYBOOK_PATH = ROOT / "gemma_playbook.md"
AUDIT_LOG = HERE / "auto_learn.log"
LAST_RUN_FILE = HERE / ".last_run"
LAST_ANALYZE_FILE = HERE / ".last_analyze"
MIN_NEW_ENTRIES_TO_DISTILL = int(os.environ.get("MIN_NEW_ENTRIES_TO_DISTILL", "5"))
ANALYZE_HOUR_START = int(os.environ.get("ANALYZE_HOUR_START", "1"))   # 01:00
ANALYZE_HOUR_END = int(os.environ.get("ANALYZE_HOUR_END", "5"))       # 05:00

PY = sys.executable


def audit(entry: dict):
    entry["ts"] = time.time()
    entry["ts_iso"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        with AUDIT_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def content_log_line_count() -> int:
    if not CONTENT_LOG.exists():
        return 0
    try:
        with CONTENT_LOG.open("r", encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def read_last_run_count() -> int:
    try:
        return int(LAST_RUN_FILE.read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return 0


def write_last_run_count(n: int):
    try:
        LAST_RUN_FILE.write_text(str(n), encoding="utf-8")
    except Exception:
        pass


def analyze_due(force_all: bool) -> bool:
    if force_all:
        return True
    hour = int(time.strftime("%H"))
    if not (ANALYZE_HOUR_START <= hour < ANALYZE_HOUR_END):
        return False
    today = time.strftime("%Y-%m-%d")
    try:
        last = LAST_ANALYZE_FILE.read_text(encoding="utf-8").strip()
        return last != today
    except Exception:
        return True


def write_last_analyze():
    try:
        LAST_ANALYZE_FILE.write_text(time.strftime("%Y-%m-%d"), encoding="utf-8")
    except Exception:
        pass


def run(cmd, timeout):
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace",
    )


def main():
    # --force        bypass idle_guard only (still skip if no new content)
    # --force-all    bypass every gate (for manual re-distillation)
    force_idle = "--force" in sys.argv or "--force-all" in sys.argv
    force_all = "--force-all" in sys.argv

    # Gate 1: idle_guard
    guard_cmd = [PY, str(HERE / "idle_guard.py"), "--quiet"]
    if force_idle:
        guard_cmd.append("--force")
    try:
        guard = run(guard_cmd, timeout=60)
    except Exception as e:
        audit({"phase": "guard", "ok": False, "error": str(e)})
        sys.exit(1)

    if guard.returncode != 0:
        audit({"phase": "guard", "ok": False, "skipped": True, "reason": "gates not met"})
        sys.exit(0)

    # Gate 2: enough new entries since last run
    total = content_log_line_count()
    last = read_last_run_count()
    new_entries = max(0, total - last)
    if not force_all and new_entries < MIN_NEW_ENTRIES_TO_DISTILL:
        audit({
            "phase": "gate_new_entries", "ok": True, "skipped": True,
            "total_entries": total, "last_run_count": last, "new_entries": new_entries,
            "threshold": MIN_NEW_ENTRIES_TO_DISTILL,
        })
        sys.exit(0)

    # Distill
    t0 = time.time()
    try:
        distill = run([PY, str(HERE / "distill.py")], timeout=360)
    except Exception as e:
        audit({"phase": "distill", "ok": False, "error": str(e)})
        sys.exit(2)

    dt = time.time() - t0
    if distill.returncode != 0:
        audit({
            "phase": "distill", "ok": False, "returncode": distill.returncode,
            "stdout": distill.stdout[-400:], "stderr": distill.stderr[-400:],
            "seconds": round(dt, 2),
        })
        sys.exit(3)

    # Parse distill stdout (last non-empty line = JSON result)
    distill_result = {}
    for line in reversed([l for l in distill.stdout.splitlines() if l.strip()]):
        try:
            distill_result = json.loads(line)
            break
        except Exception:
            continue

    write_last_run_count(total)
    audit({
        "phase": "distill", "ok": True, "seconds": round(dt, 2),
        "new_entries_since_last": new_entries,
        "total_entries": total,
        "distill_result": distill_result,
        "playbook_path": str(PLAYBOOK_PATH),
        "playbook_exists": PLAYBOOK_PATH.exists(),
    })

    # Step 3: daily session analysis (凌晨 1–5 點 + 今天還沒跑過)
    if not analyze_due(force_all):
        audit({"phase": "analyze", "ok": True, "skipped": True,
               "reason": f"not in window ({ANALYZE_HOUR_START}–{ANALYZE_HOUR_END}h) or already ran today"})
        return

    t0 = time.time()
    analyze_cmd = [PY, str(HERE / "analyze_sessions.py")]
    if force_all:
        analyze_cmd.append("--force")
    try:
        analyze = run(analyze_cmd, timeout=1800)  # 30 min max for 5 sections
    except Exception as e:
        audit({"phase": "analyze", "ok": False, "error": str(e)})
        return

    dt = time.time() - t0
    if analyze.returncode != 0:
        audit({"phase": "analyze", "ok": False, "returncode": analyze.returncode,
               "stdout": analyze.stdout[-600:], "stderr": analyze.stderr[-400:],
               "seconds": round(dt, 2)})
        return

    write_last_analyze()
    last_line = next((l for l in reversed(analyze.stdout.splitlines()) if l.strip()), "")
    audit({"phase": "analyze", "ok": True, "seconds": round(dt, 2), "summary": last_line})


if __name__ == "__main__":
    main()
