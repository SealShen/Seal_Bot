#!/usr/bin/env node
/**
 * obs-mask-hook.js
 * Claude Code PostToolUse hook — 將過長的工具結果外部化為暫存檔
 * 每天首次執行時清理 30 天未修改的暫存檔
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const OBS_DIR      = path.join(os.homedir(), '.claude', 'obs-cache');
const MARKER_FILE  = path.join(OBS_DIR, '.last-cleanup');
const THRESHOLD    = 2000;           // 超過此字元數才外部化
const CLEANUP_DAYS = 30;
const MS_PER_DAY   = 86_400_000;

// 這些工具的輸出不需要外部化（通常很短或是寫入操作）
const SKIP_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'TodoWrite', 'TodoRead', 'Task']);

// ── 每日清理 ───────────────────────────────────────────────────────────────────
function runCleanupIfNeeded() {
  const now = Date.now();
  try {
    const last = fs.statSync(MARKER_FILE).mtimeMs;
    if (now - last < MS_PER_DAY) return;  // 今天已跑過
  } catch {}

  try {
    const cutoff = now - CLEANUP_DAYS * MS_PER_DAY;
    for (const f of fs.readdirSync(OBS_DIR)) {
      if (f.startsWith('.')) continue;
      const fp = path.join(OBS_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}

  try { fs.writeFileSync(MARKER_FILE, String(now), 'utf8'); } catch {}
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch {}

  const toolName = data.tool_name || '';
  const output   = data.tool_response?.output ?? '';

  // 略過指定工具或短結果
  if (SKIP_TOOLS.has(toolName) || typeof output !== 'string' || output.length <= THRESHOLD) {
    process.exit(0);
  }

  // 確保目錄存在，執行每日清理
  fs.mkdirSync(OBS_DIR, { recursive: true });
  runCleanupIfNeeded();

  // 寫入暫存檔
  const id    = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fname = `${toolName}_${id}.txt`;
  const fpath = path.join(OBS_DIR, fname).replace(/\\/g, '/');

  try {
    fs.writeFileSync(path.join(OBS_DIR, fname), output, 'utf8');
  } catch {
    process.exit(0);  // 寫入失敗就放行原始輸出
  }

  const lines   = output.split('\n').length;
  const summary = `[觀測結果已外部化至暫存檔：${fpath}，共 ${lines} 行 / ${output.length} 字元。若需完整內容，請用 Read 工具讀取該路徑。]`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      outputOverride: summary,
    },
  }));

  process.exit(0);
});
