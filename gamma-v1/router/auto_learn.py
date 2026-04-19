"""auto_learn.py — orchestrator called by Task Scheduler.

Flow:
  1. Run idle_guard.py in-process. Exit quietly if gates not met.
  2. Check content log has grown since last successful run (no point re-distilling
     the same corpus).
  3. Call distill.py to refresh gemma_playbook.md.
  4. Append a line to auto_learn.log for audit.

All runs — pass or skip — write a single JSONL audit entry so you can inspect
what happened via: Get-Content gamma-v1\\router\\auto_learn.log -Tail 20
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
MIN_NEW_ENTRIES_TO_DISTILL = int(os.environ.get("MIN_NEW_ENTRIES_TO_DISTILL", "5"))

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


if __name__ == "__main__":
    main()
