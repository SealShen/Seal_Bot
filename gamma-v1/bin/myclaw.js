#!/usr/bin/env node
'use strict';
/**
 * bin/myclaw.js — MyClaw v1 CLI entry point
 *
 * Usage:
 *   node bin/myclaw.js [flags] <task>
 *   echo "task" | node bin/myclaw.js [flags]
 *
 * Flags:
 *   --profile <p>     Force profile (explorer|implementer|architect|security)
 *   --executor <e>    Force executor (local_gamma4|local_claude_code)
 *   --dir <path>      Working directory
 *   --session <id>    Resume Claude Code session
 *   --new             Force new Claude Code session
 *   --yes             Auto-confirm dangerous operations (use carefully)
 *   --health          Check LM Studio reachability and exit
 *   --log [n]         Show last n audit entries (default 20) and exit
 */
const path = require('path');
require('../lib/load-env');

const { execute }  = require('../index');
const { recent }   = require('../hooks/audit_log');
const lmstudio     = require('../adapters/lmstudio_client');

const args = process.argv.slice(2);

// ── --health ──────────────────────────────────────────────────────────────────
if (args[0] === '--health') {
  lmstudio.healthCheck().then(ok => {
    if (ok) {
      console.log('[OK] LM Studio is reachable at', process.env.GOOGLE_AI_BASE_URL || 'http://localhost:1234/v1');
      process.exit(0);
    } else {
      console.error('[FAIL] LM Studio is NOT reachable. Is it running with a model loaded?');
      process.exit(1);
    }
  });
  return;
}

// ── --log [n] ─────────────────────────────────────────────────────────────────
if (args[0] === '--log') {
  const n       = parseInt(args[1]) || 20;
  const entries = recent(n);
  if (!entries.length) { console.log('(no audit entries yet)'); process.exit(0); }
  for (const e of entries) {
    const tag = e.event === 'blocked' ? '[BLOCKED]'
              : e.event === 'task_end' ? (e.ok ? '[OK]' : '[ERR]')
              : `[${e.event}]`;
    console.log(`${e.ts}  ${tag.padEnd(12)} profile=${e.profile||'-'}  executor=${e.executor||'-'}  ${e.reason||e.error||''}`);
  }
  process.exit(0);
}

// ── Parse flags ───────────────────────────────────────────────────────────────
let profile     = null;
let executor    = null;
let workDir     = null;
let sessionId   = null;
let forceNew    = false;
let skipConfirm = false;
let promptParts = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if      (a === '--profile'  && args[i+1]) { profile   = args[++i]; }
  else if (a === '--executor' && args[i+1]) { executor  = args[++i]; }
  else if (a === '--dir'      && args[i+1]) { workDir   = args[++i]; }
  else if (a === '--session'  && args[i+1]) { sessionId = args[++i]; }
  else if (a === '--new')                    { forceNew  = true; }
  else if (a === '--yes')                    { skipConfirm = true; }
  else { promptParts.push(a); }
}

async function run(prompt) {
  if (!prompt.trim()) { console.error('No task provided.'); process.exit(1); }

  const result = await execute({ prompt, profile, executor, workDir, sessionId, forceNew, skipConfirm });

  // ── Output ──────────────────────────────────────────────────────────────────
  if (result.blocked) {
    console.error(`\n[BLOCKED] ${result.reason}`);
    process.exit(2);
  }

  if (result.needsConfirm) {
    console.log(`\n[CONFIRM REQUIRED] ${result.confirmReason}`);
    console.log('Re-run with --yes to proceed.');
    process.exit(3);
  }

  const status = result.ok ? '[OK]' : '[ERR]';
  console.log(`\n${status} profile=${result.profile}  executor=${result.executor}  ${result.latencyMs}ms`);

  if (result.snapshot) {
    const s = result.snapshot;
    console.log(`[SNAP] type=${s.type}  ref=${s.ref}`);
  }

  if (result.content) {
    console.log('\n' + result.content);
  }

  if (!result.ok && result.error) {
    console.error('\n[ERROR]', result.error);
  }

  if (result.suggestUpgrade) {
    console.log(`\n[SUGGEST] This task may benefit from a higher profile: --profile ${result.suggestUpgrade}`);
  }

  process.exit(result.ok ? 0 : 1);
}

// Prompt from CLI args or stdin
if (promptParts.length) {
  run(promptParts.join(' '));
} else {
  // Interactive / piped stdin
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8').trim()));
}
