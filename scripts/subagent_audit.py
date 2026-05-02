#!/usr/bin/env python3
"""Audit subagent token usage across all Claude Code projects.

Scans ~/.claude/projects/*/<session>/subagents/agent-*.jsonl, aggregates
token usage by agent type and date, identifies likely-misrouted calls
(short prompts that triggered think_deeply / Opus models).
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECTS = Path(os.path.expanduser("~/.claude/projects"))
WINDOW_DAYS = 14
SHORT_PROMPT_CHARS = 400  # heuristic for "should have been inline"

# Sonnet-eq weights (rough): Opus 5x Sonnet, Haiku 1/5
SONNET_EQ = {
    "opus": 5.0,
    "sonnet": 1.0,
    "haiku": 0.2,
    "unknown": 1.0,
}


def model_family(model: str) -> str:
    if not model:
        return "unknown"
    m = model.lower()
    if "opus" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    return "unknown"


def load_meta(meta_path: Path) -> dict:
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def iter_subagent_files():
    if not PROJECTS.exists():
        return
    for project in PROJECTS.iterdir():
        if not project.is_dir():
            continue
        for session in project.iterdir():
            sub = session / "subagents" if session.is_dir() else None
            if not sub or not sub.exists():
                continue
            for jsonl in sub.glob("agent-*.jsonl"):
                meta = sub / (jsonl.stem + ".meta.json")
                yield project.name, session.name, jsonl, meta


def main():
    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    by_type = defaultdict(lambda: {
        "calls": 0,
        "input": 0,
        "cache_creation": 0,
        "cache_read": 0,
        "output": 0,
        "turns": 0,
        "short_prompt_calls": 0,
        "models": defaultdict(int),
        "sonnet_eq": 0.0,
    })
    by_day_type = defaultdict(lambda: defaultdict(int))
    flagged = []  # candidate misroutes

    total_files = 0
    in_window = 0

    for project, session, jsonl, meta_path in iter_subagent_files():
        total_files += 1
        meta = load_meta(meta_path)
        agent_type = meta.get("agentType", "unknown")
        description = meta.get("description", "")

        first_user_prompt = None
        first_ts = None
        turn_count = 0
        agg = {"input": 0, "cache_creation": 0, "cache_read": 0, "output": 0}
        models_seen = defaultdict(int)

        try:
            with jsonl.open("r", encoding="utf-8") as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    rtype = rec.get("type")
                    msg = rec.get("message", {}) if isinstance(rec.get("message"), dict) else {}
                    if rtype == "user" and first_user_prompt is None:
                        content = msg.get("content")
                        if isinstance(content, str):
                            first_user_prompt = content
                            ts = rec.get("timestamp")
                            if ts:
                                try:
                                    first_ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                                except Exception:
                                    pass
                    if rtype == "assistant":
                        turn_count += 1
                        usage = msg.get("usage", {}) or {}
                        agg["input"] += int(usage.get("input_tokens") or 0)
                        agg["cache_creation"] += int(usage.get("cache_creation_input_tokens") or 0)
                        agg["cache_read"] += int(usage.get("cache_read_input_tokens") or 0)
                        agg["output"] += int(usage.get("output_tokens") or 0)
                        models_seen[model_family(msg.get("model", ""))] += 1
        except FileNotFoundError:
            continue

        if first_ts is None or first_ts < cutoff:
            continue
        in_window += 1

        # Sonnet-equivalent: weight effective input by model family share
        total_input_eq = agg["input"] + agg["cache_creation"] + agg["cache_read"]
        # Output usually billed higher; assume 5x for sonnet-eq billing weight
        total_calls = sum(models_seen.values()) or 1
        weight = sum(SONNET_EQ[fam] * cnt for fam, cnt in models_seen.items()) / total_calls
        sonnet_eq = (total_input_eq + agg["output"] * 5) * weight

        bucket = by_type[agent_type]
        bucket["calls"] += 1
        bucket["input"] += agg["input"]
        bucket["cache_creation"] += agg["cache_creation"]
        bucket["cache_read"] += agg["cache_read"]
        bucket["output"] += agg["output"]
        bucket["turns"] += turn_count
        for fam, cnt in models_seen.items():
            bucket["models"][fam] += cnt
        bucket["sonnet_eq"] += sonnet_eq

        prompt_len = len(first_user_prompt or "")
        if prompt_len < SHORT_PROMPT_CHARS:
            bucket["short_prompt_calls"] += 1
            if agent_type == "think_deeply" or "opus" in models_seen:
                flagged.append({
                    "agent_type": agent_type,
                    "ts": first_ts.isoformat(),
                    "prompt_chars": prompt_len,
                    "turns": turn_count,
                    "sonnet_eq": int(sonnet_eq),
                    "project": project,
                    "session": session,
                    "description": description[:80],
                })

        day = first_ts.strftime("%Y-%m-%d")
        by_day_type[day][agent_type] += 1

    print(f"=== Subagent audit: window {WINDOW_DAYS} days, cutoff {cutoff.isoformat()} ===")
    print(f"total subagent files scanned: {total_files}")
    print(f"in window: {in_window}\n")

    print(f"{'agent_type':<22} {'calls':>6} {'turns':>7} {'short':>6} "
          f"{'cache_cr':>10} {'cache_rd':>10} {'output':>9} {'sonnet_eq':>11} models")
    rows = sorted(by_type.items(), key=lambda kv: -kv[1]["sonnet_eq"])
    grand_eq = 0
    for atype, b in rows:
        models_str = ",".join(f"{k}:{v}" for k, v in sorted(b["models"].items(), key=lambda kv: -kv[1]))
        grand_eq += b["sonnet_eq"]
        print(f"{atype:<22} {b['calls']:>6} {b['turns']:>7} {b['short_prompt_calls']:>6} "
              f"{b['cache_creation']:>10,} {b['cache_read']:>10,} {b['output']:>9,} "
              f"{int(b['sonnet_eq']):>11,} {models_str}")
    print(f"\nGrand total sonnet-eq input+output*5 weighted: {int(grand_eq):,}")

    print("\n=== Daily call counts ===")
    for day in sorted(by_day_type.keys()):
        cnts = by_day_type[day]
        line = " ".join(f"{k}:{v}" for k, v in sorted(cnts.items(), key=lambda kv: -kv[1]))
        print(f"{day}  {line}")

    print(f"\n=== Flagged: short prompt + (think_deeply or Opus) — {len(flagged)} hits ===")
    flagged.sort(key=lambda x: -x["sonnet_eq"])
    for f in flagged[:20]:
        print(f"  {f['ts']}  {f['agent_type']:<14} chars={f['prompt_chars']:<4} "
              f"turns={f['turns']:<3} eq={f['sonnet_eq']:>10,}  {f['description']}")


if __name__ == "__main__":
    main()
