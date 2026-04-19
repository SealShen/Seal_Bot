"""cleanup_drafts.py — delete stale scratch files in repo root.

Scope: files in the MyClaw repo root matching `_*.md` / `_*.txt` / `_*.json`.
Delete criterion: both mtime AND atime older than CLEANUP_AGE_DAYS (default 7).
Safety:
  - Only files in repo root (non-recursive), never in subdirectories
  - Skip git-tracked files (assume intentional)
  - Skip the .claude-auto-commit marker (doesn't match pattern, but defensive)

Run:
  python cleanup_drafts.py              # delete
  python cleanup_drafts.py --dry-run    # list only, no delete
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent  # gamma-v1/router/ -> gamma-v1/ -> MyClaw/
AGE_DAYS = int(os.environ.get("CLEANUP_AGE_DAYS", "7"))
PATTERNS = ["_*.md", "_*.txt", "_*.json"]


def is_git_tracked(repo: Path, file_path: Path) -> bool:
    rel = file_path.relative_to(repo).as_posix()
    r = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel],
        cwd=str(repo), capture_output=True, text=True,
    )
    return r.returncode == 0


def scan(repo: Path, age_days: int):
    cutoff = time.time() - age_days * 86400
    stale, fresh, tracked = [], [], []
    for pat in PATTERNS:
        for p in repo.glob(pat):
            if not p.is_file():
                continue
            if is_git_tracked(repo, p):
                tracked.append(p.name)
                continue
            st = p.stat()
            # "沒有更動或存取" = both mtime AND atime must be older than cutoff
            last_touched = max(st.st_mtime, st.st_atime)
            age_d = (time.time() - last_touched) / 86400
            if last_touched < cutoff:
                stale.append((p, age_d))
            else:
                fresh.append((p.name, age_d))
    return stale, fresh, tracked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    stale, fresh, tracked = scan(REPO, AGE_DAYS)

    deleted = []
    for p, age_d in stale:
        if args.dry_run:
            print(f"[dry-run] would delete {p.name} (age={age_d:.1f}d)")
            continue
        try:
            p.unlink()
            deleted.append(p.name)
            print(f"[deleted] {p.name} (age={age_d:.1f}d)")
        except Exception as e:
            print(f"[error] {p.name}: {e}", file=sys.stderr)

    result = {
        "repo": str(REPO),
        "age_days": AGE_DAYS,
        "deleted": deleted if not args.dry_run else [p.name for p, _ in stale],
        "dry_run": args.dry_run,
        "kept_fresh": [{"name": n, "age_days": round(a, 1)} for n, a in fresh],
        "kept_tracked": tracked,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
