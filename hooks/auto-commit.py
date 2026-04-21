#!/usr/bin/env python3
"""PostToolUse(Edit|Write) hook: 任何寫入 .claude-auto-commit 標記過的 repo 後，
立即 commit 該檔案。Commit message 委派給 Gemma（失敗則用 fallback）。

Opt-in：在 repo 根目錄建立 `.claude-auto-commit` 空檔即啟用。

Env vars:
  CLAUDE_AUTO_COMMIT_DISABLE=1  暫時關閉（不論標記是否存在）
  CLAUDE_AUTO_COMMIT_DRY_RUN=1  只印訊息，不實際 commit
  LMSTUDIO_BASE_URL             Gemma endpoint（預設 localhost:1234/v1）
  LMSTUDIO_MODEL                Gemma model id
  LMSTUDIO_API_KEY              Gemma API key

退出：永遠 exit 0（不阻斷 Claude），訊息印到 stdout 供使用者看見。
"""
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


def log(msg: str):
    print(f"[auto-commit] {msg}")


def _load_dotenv_for(repo: Path):
    """Best-effort: load gamma-v1/.env from repo if present (for LMSTUDIO_* keys)."""
    for candidate in (repo / "gamma-v1" / ".env", repo / ".env"):
        if not candidate.exists():
            continue
        try:
            for line in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except Exception:
            pass
        return


def find_repo_root(path: Path) -> Path | None:
    for parent in [path, *path.parents]:
        if (parent / ".git").exists():
            return parent
    return None


def run(cmd, cwd=None, timeout=10):
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return 1, "", str(e)


def has_changes(repo: Path, file_rel: str) -> bool:
    rc, out, _ = run(["git", "status", "--porcelain", "--", file_rel], cwd=str(repo))
    return rc == 0 and bool(out.strip())


def is_ignored(repo: Path, file_rel: str) -> bool:
    rc, _, _ = run(["git", "check-ignore", "--", file_rel], cwd=str(repo))
    return rc == 0


def get_diff(repo: Path, file_rel: str, max_chars: int = 2500) -> str:
    # 包含未追蹤檔案的情況：先嘗試 diff，若空則當作新檔
    _, out, _ = run(["git", "diff", "HEAD", "--", file_rel], cwd=str(repo))
    if not out.strip():
        _, out, _ = run(["git", "diff", "--no-index", "/dev/null", file_rel], cwd=str(repo))
    return out[:max_chars]


def gemma_message(diff: str, filename: str, timeout=12) -> str | None:
    base = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1").rstrip("/")
    model = os.environ.get("LMSTUDIO_MODEL", "local-model")
    key = os.environ.get("LMSTUDIO_API_KEY", "")

    prompt = (
        "請關閉 Chain-of-Thought / thinking 模式，直接給出答案。\n"
        "根據以下 git diff，輸出一行繁體中文 commit message（不超過 60 字）。\n"
        "格式：`<type>: <描述>`，type 從 feat/fix/refactor/docs/style/test/chore 擇一。\n"
        "只輸出 commit message 本身，不要加引號、前綴說明或換行。\n\n"
        f"檔案：{filename}\n\n"
        f"diff:\n{diff}"
    )
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 120,
        "stream": False,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        req = urllib.request.Request(base + "/chat/completions", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode("utf-8"))
        msg = (resp.get("choices") or [{}])[0].get("message", {}) or {}
        content = (msg.get("content") or msg.get("reasoning_content") or "").strip()
        # 清理：取第一行，去除包圍引號
        line = content.splitlines()[0].strip() if content else ""
        line = line.strip("`\"' ")
        return line[:80] if line else None
    except Exception:
        return None


def fallback_message(filename: str) -> str:
    return f"chore({filename}): auto-commit via Edit/Write"


def main():
    if os.environ.get("CLAUDE_AUTO_COMMIT_DISABLE") == "1":
        sys.exit(0)

    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    if tool_name not in ("Edit", "Write"):
        sys.exit(0)

    tool_input = data.get("tool_input") or {}
    file_path_raw = tool_input.get("file_path") or ""
    if not file_path_raw:
        sys.exit(0)

    file_path = Path(file_path_raw).resolve()
    if not file_path.exists():
        sys.exit(0)

    repo = find_repo_root(file_path)
    if not repo:
        sys.exit(0)

    marker = repo / ".claude-auto-commit"
    if not marker.exists():
        sys.exit(0)

    _load_dotenv_for(repo)

    try:
        file_rel = str(file_path.relative_to(repo)).replace("\\", "/")
    except ValueError:
        sys.exit(0)

    if is_ignored(repo, file_rel):
        sys.exit(0)

    if not has_changes(repo, file_rel):
        sys.exit(0)

    diff = get_diff(repo, file_rel)
    if not diff.strip():
        sys.exit(0)

    dry_run = os.environ.get("CLAUDE_AUTO_COMMIT_DRY_RUN") == "1"
    msg = gemma_message(diff, file_path.name) or fallback_message(file_path.name)

    if dry_run:
        log(f"DRY-RUN would commit {file_rel}: {msg}")
        sys.exit(0)

    rc, _, err = run(["git", "add", "--", file_rel], cwd=str(repo))
    if rc != 0:
        log(f"git add failed for {file_rel}: {err.strip()[:200]}")
        sys.exit(0)

    rc, _, err = run(["git", "commit", "-m", msg, "--", file_rel], cwd=str(repo))
    if rc != 0:
        # 常見失敗：nothing to commit (race condition)、hook rejection
        log(f"git commit skipped for {file_rel}: {err.strip()[:200]}")
        sys.exit(0)

    log(f"committed {file_rel}: {msg}")
    sys.exit(0)


if __name__ == "__main__":
    main()
