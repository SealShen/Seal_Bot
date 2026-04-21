"""idle_guard.py — decide whether auto-learn may run right now.

Three gates (ALL must pass):
  1. User idle (kbd/mouse inactive) for > IDLE_MIN_SECONDS
  2. No active Claude Code session (no 'claude' process, no recent transcript mtime)
  3. LM Studio reachable at GOOGLE_AI_BASE_URL

Exit code 0 = OK to run, 1 = skip.
Always prints a JSON result to stdout so orchestrator can log it.

Usage:
  python idle_guard.py          # enforce gates
  python idle_guard.py --force  # override all gates (for manual test)
"""
import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path


def _load_dotenv():
    """Minimal .env loader — no external deps, won't overwrite existing env."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
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

IDLE_MIN_SECONDS = int(os.environ.get("IDLE_MIN_SECONDS", "1200"))  # 20 minutes
CLAUDE_TRANSCRIPT_IDLE_SECONDS = int(os.environ.get("CLAUDE_TRANSCRIPT_IDLE_SECONDS", "1800"))  # 30 min
GOOGLE_AI_BASE_URL = os.environ.get("GOOGLE_AI_BASE_URL", "http://localhost:1234/v1")
LMSTUDIO_API_KEY = os.environ.get("LMSTUDIO_API_KEY", "")
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"


def system_idle_seconds() -> float:
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(info)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    tick = ctypes.windll.kernel32.GetTickCount()
    return max(0.0, (tick - info.dwTime) / 1000.0)


def claude_process_running() -> bool:
    # Claude Code on Windows typically runs as node.exe under a user shell.
    # tasklist /V gives window title / command context; wmic is deprecated.
    # Cheap heuristic: any claude.exe OR any node with "claude" in the window title.
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq claude.exe"],
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).decode("mbcs", errors="ignore").lower()
        if "claude.exe" in out:
            return True
    except Exception:
        pass
    # Fallback: PowerShell Get-Process for processes named 'claude*' (cheap, no WMI).
    try:
        ps = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process -ErrorAction SilentlyContinue | "
             "Where-Object { $_.ProcessName -like 'claude*' } | "
             "Measure-Object | Select-Object -ExpandProperty Count"],
            capture_output=True, text=True, timeout=15,
        )
        if ps.returncode == 0 and ps.stdout.strip().isdigit():
            return int(ps.stdout.strip()) > 0
    except Exception:
        pass
    return False


def latest_transcript_age_seconds():
    if not CLAUDE_PROJECTS_DIR.exists():
        return None
    latest = 0.0
    for p in CLAUDE_PROJECTS_DIR.rglob("*.jsonl"):
        try:
            m = p.stat().st_mtime
            if m > latest:
                latest = m
        except Exception:
            continue
    if latest == 0.0:
        return None
    return max(0.0, time.time() - latest)


def lm_studio_reachable() -> bool:
    url = GOOGLE_AI_BASE_URL.rstrip("/") + "/models"
    headers = {}
    if LMSTUDIO_API_KEY:
        headers["Authorization"] = f"Bearer {LMSTUDIO_API_KEY}"
    try:
        req = urllib.request.Request(url, method="GET", headers=headers)
        with urllib.request.urlopen(req, timeout=5) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="bypass all gates")
    parser.add_argument("--quiet", action="store_true", help="suppress stdout JSON")
    args = parser.parse_args()

    idle = system_idle_seconds()
    claude_proc = claude_process_running()
    transcript_age = latest_transcript_age_seconds()
    lm_ok = lm_studio_reachable()

    transcript_idle_ok = (
        transcript_age is None or transcript_age > CLAUDE_TRANSCRIPT_IDLE_SECONDS
    )
    idle_ok = idle > IDLE_MIN_SECONDS
    no_claude = (not claude_proc) and transcript_idle_ok

    should_run = bool(args.force or (idle_ok and no_claude and lm_ok))

    result = {
        "ts": time.time(),
        "idle_seconds": round(idle, 1),
        "idle_threshold": IDLE_MIN_SECONDS,
        "idle_ok": idle_ok,
        "claude_process_running": claude_proc,
        "transcript_age_seconds": None if transcript_age is None else round(transcript_age, 1),
        "transcript_idle_ok": transcript_idle_ok,
        "lm_studio_ok": lm_ok,
        "forced": args.force,
        "should_run": should_run,
    }
    if not args.quiet:
        print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if should_run else 1)


if __name__ == "__main__":
    main()
