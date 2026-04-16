#!/usr/bin/env python3
"""
router-savings-report.py
估算 MODEL_ROUTER haiku sub-agent 節省的 token 量

用法：
  python3 scripts/router-savings-report.py [today|week|all]
  python3 scripts/router-savings-report.py all --verbose

設定方式：修改下方 PROJECT_DIRS，填入你的 ~/.claude/projects/ 子目錄名稱。
目錄命名規則：路徑中的 / 和 \ 替換為 -，例如：
  ~/MyClaw  →  ~/.claude/projects/c--Users-yourname-MyClaw  (Windows)
  ~/myproj  →  ~/.claude/projects/home-yourname-myproj      (Linux/Mac)
"""

import json
import glob
import os
import sys
from datetime import datetime, timedelta, timezone

# Windows stdout UTF-8
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# ── 請依個人環境修改 ────────────────────────────────────────────
PROJECT_DIRS = [
    os.path.expanduser('~/.claude/projects/YOUR_PROJECT_DIR_1'),
    os.path.expanduser('~/.claude/projects/YOUR_PROJECT_DIR_2'),
]
# ──────────────────────────────────────────────────────────────


def load_jsonl(path):
    entries = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return entries


def get_subagent_stats(agent_jsonl_path):
    """解析 sub-agent JSONL，回傳 token 用量與描述"""
    entries = load_jsonl(agent_jsonl_path)

    model = None
    tool_calls = 0
    total_input = 0
    total_cache_cr = 0
    total_cache_rd = 0
    total_output = 0
    first_ts = None

    for e in entries:
        if e.get('type') != 'assistant' or not e.get('message', {}).get('usage'):
            continue
        usage = e['message']['usage']
        if model is None:
            model = e['message'].get('model', '')
        total_input    += usage.get('input_tokens', 0)
        total_cache_cr += usage.get('cache_creation_input_tokens', 0)
        total_cache_rd += usage.get('cache_read_input_tokens', 0)
        total_output   += usage.get('output_tokens', 0)
        content = e['message'].get('content', [])
        if isinstance(content, list):
            tool_calls += sum(1 for c in content if c.get('type') == 'tool_use')
        if first_ts is None:
            first_ts = e.get('timestamp')

    agent_id = os.path.splitext(os.path.basename(agent_jsonl_path))[0].replace('agent-', '')
    meta_path = agent_jsonl_path.replace('.jsonl', '.meta.json')
    description = ''
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding='utf-8') as f:
                meta = json.load(f)
                description = meta.get('description', '')
        except Exception:
            pass

    return {
        'agent_id':       agent_id,
        'model':          model or 'unknown',
        'is_haiku':       'haiku' in (model or '').lower(),
        'tool_calls':     tool_calls,
        'input_tokens':   total_input,
        'cache_creation': total_cache_cr,
        'cache_read':     total_cache_rd,
        'output_tokens':  total_output,
        'timestamp':      first_ts,
        'description':    description,
    }


def get_main_context_at_time(session_jsonl_path, timestamp):
    """回傳指定時間點之前，主對話的 context 大小（tokens）"""
    entries = load_jsonl(session_jsonl_path)
    last_context = 0
    for e in entries:
        if e.get('type') != 'assistant':
            continue
        if e.get('isSidechain'):
            continue
        usage = e.get('message', {}).get('usage')
        if not usage:
            continue
        if (timestamp is None) or (e.get('timestamp', '') <= timestamp):
            ctx = usage.get('cache_read_input_tokens', 0) + usage.get('cache_creation_input_tokens', 0)
            last_context = max(last_context, ctx)
    return last_context


def main():
    args = sys.argv[1:]
    period = 'all'
    verbose = False
    for a in args:
        if a in ('today', 'week', 'all'):
            period = a
        elif a == '--verbose':
            verbose = True

    now = datetime.now(timezone.utc)
    if period == 'today':
        cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == 'week':
        cutoff = now - timedelta(days=7)
    else:
        cutoff = None

    all_agent_files = []
    for proj_dir in PROJECT_DIRS:
        if os.path.isdir(proj_dir):
            all_agent_files += glob.glob(
                os.path.join(proj_dir, '*/subagents/agent-*.jsonl')
            )

    results = []
    skipped_model = []

    for agent_path in sorted(all_agent_files):
        stats = get_subagent_stats(agent_path)

        if not stats['is_haiku']:
            skipped_model.append(
                f"{stats['description'] or stats['agent_id'][:16]} "
                f"({stats['model'].split('-')[1] if '-' in stats['model'] else stats['model']})"
            )
            continue

        if cutoff and stats['timestamp']:
            ts = datetime.fromisoformat(stats['timestamp'].replace('Z', '+00:00'))
            if ts < cutoff:
                continue

        parts = agent_path.replace('\\', '/').split('/')
        session_id = parts[-3]
        proj_dir   = '/'.join(parts[:-3])
        main_path  = os.path.join(proj_dir, f'{session_id}.jsonl')
        main_context = 0
        if os.path.exists(main_path):
            main_context = get_main_context_at_time(main_path, stats['timestamp'])

        # ── 節省估算邏輯 ──────────────────────────────────────────────
        # 若同樣 N 次工具呼叫在主對話 inline 執行：
        #   每次工具呼叫都要帶著完整 main_context 作為輸入
        #   inline_cost ≈ main_context × max(tool_calls, 1)
        #
        # 使用 sub-agent 的實際成本：
        #   cache_creation 才是 sub-agent 獨自新增的額外工作量
        #   actual_new = cache_creation + input（排除共享快取）
        #
        # 節省量 = inline_cost - actual_new
        # ─────────────────────────────────────────────────────────────
        inline_cost = main_context * max(stats['tool_calls'], 1)
        actual_new  = stats['cache_creation'] + stats['input_tokens']
        saved       = inline_cost - actual_new

        results.append({
            **stats,
            'main_context': main_context,
            'inline_cost':  inline_cost,
            'actual_new':   actual_new,
            'saved':        saved,
            'session_id':   session_id,
        })

    W = 64
    print()
    print('=' * W)
    print(f"  MODEL_ROUTER 節省估算報告  [{period}]")
    print('=' * W)
    print(f"  Haiku sub-agent 數：{len(results)}")
    if skipped_model and verbose:
        print(f"  跳過（非 haiku）：{', '.join(skipped_model)}")
    print()

    for r in results:
        ts_str = r['timestamp'][:10] if r['timestamp'] else 'n/a'
        label  = (r['description'] or r['agent_id'][:20])[:36]
        print(f"  [{ts_str}]  {label}")
        if verbose:
            print(f"    session  : {r['session_id'][:8]}...")
            print(f"    model    : {r['model']}")
        print(f"    工具呼叫  : {r['tool_calls']} 次")
        print(f"    主 context: {r['main_context']:>8,} tokens（呼叫時）")
        print(f"    ├ inline 估算成本  : {r['inline_cost']:>8,} tokens")
        print(f"    ├ sub-agent 實際新增: {r['actual_new']:>8,} tokens")
        pct = (r['saved'] / r['inline_cost'] * 100) if r['inline_cost'] else 0
        print(f"    └ 估算節省         : {r['saved']:>8,} tokens  ({pct:.0f}%)")
        print()

    total_inline = sum(r['inline_cost'] for r in results)
    total_actual = sum(r['actual_new']  for r in results)
    total_saved  = sum(r['saved']       for r in results)
    total_pct    = (total_saved / total_inline * 100) if total_inline else 0

    print('─' * W)
    print(f"  {'若全部 inline 估算':<24}: {total_inline:>10,} tokens")
    print(f"  {'Sub-agent 實際新增':<24}: {total_actual:>10,} tokens")
    print(f"  {'估算節省':<24}: {total_saved:>10,} tokens  ({total_pct:.0f}%)")
    print('=' * W)
    print()


if __name__ == '__main__':
    main()
