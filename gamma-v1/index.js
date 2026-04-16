'use strict';
/**
 * gamma-v1/index.js
 * Main routing engine: classify → policy → snapshot → execute → audit
 */
const path = require('path');
require('./lib/load-env');

const { classify }                = require('./router/task_classifier');
const { route, suggestUpgrade }   = require('./router/route_profile');
const { check }                   = require('./router/policy');
const { snapshot }                = require('./hooks/pre_snapshot');
const { log }                     = require('./hooks/audit_log');
const lmstudio                    = require('./adapters/lmstudio_client');
const claudeCode                  = require('./adapters/claude_code_runner');

/**
 * Execute a task through the routing engine.
 *
 * @param {object} opts
 * @param {string}   opts.prompt            — task description
 * @param {string}  [opts.profile]          — explicit profile override
 * @param {string}  [opts.executor]         — explicit executor override
 * @param {string}  [opts.workDir]          — working directory
 * @param {string}  [opts.sessionId]        — Claude Code session to resume
 * @param {boolean} [opts.forceNew=false]   — force new Claude Code session
 * @param {string}  [opts.systemPrompt]     — system prompt for LM Studio
 * @param {boolean} [opts.skipConfirm=false] — skip confirm gate (caller handles it)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   executor: string,
 *   profile: string,
 *   content?: string,
 *   error?: string,
 *   blocked?: boolean,
 *   needsConfirm?: boolean,
 *   confirmReason?: string,
 *   snapshot?: object,
 *   suggestUpgrade?: string,
 *   latencyMs: number,
 * }>}
 */
async function execute({
  prompt,
  profile:      explicitProfile  = null,
  executor:     explicitExecutor = null,
  workDir       = null,
  sessionId     = null,
  forceNew      = false,
  systemPrompt  = null,
  history       = [],     // prior conversation turns for multi-turn gamma mode
  skipConfirm   = false,
} = {}) {
  const _workDir = workDir || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const startMs  = Date.now();

  // ── 1. Classify ──────────────────────────────────────────────────────────────
  const { profile: autoProfile, auto, scores } = classify(prompt);
  const profile = explicitProfile || autoProfile;

  // ── 2. Route ─────────────────────────────────────────────────────────────────
  const { executor, readOnly, needsSnap } = route(profile, explicitExecutor);

  // ── 3. Policy check ──────────────────────────────────────────────────────────
  const policy = check(prompt, { readOnly, workDir: _workDir });

  if (policy.action === 'block') {
    log({ event: 'blocked', profile, executor, reason: policy.reason, prompt: prompt.slice(0, 100) });
    return {
      ok: false, blocked: true,
      reason: policy.reason,
      profile, executor,
      latencyMs: Date.now() - startMs,
    };
  }

  if (policy.action === 'confirm' && !skipConfirm) {
    // Caller must re-invoke with skipConfirm:true after user approves
    log({ event: 'needs_confirm', profile, executor, reason: policy.reason, prompt: prompt.slice(0, 100) });
    return {
      ok: false, needsConfirm: true,
      confirmReason: policy.reason,
      profile, executor,
      latencyMs: Date.now() - startMs,
    };
  }

  // ── 4. Pre-write snapshot ────────────────────────────────────────────────────
  let snap = null;
  if (needsSnap) {
    snap = snapshot(_workDir, prompt.slice(0, 40));
    log({
      event:    'snapshot',
      profile,  executor,
      snapType: snap.type,
      snapRef:  snap.ref,
      snapOk:   snap.ok,
      workDir:  _workDir,
    });
  }

  // ── 5. Audit: task start ─────────────────────────────────────────────────────
  log({
    event:    'task_start',
    profile,  auto,  scores,
    executor, readOnly,
    snapshot: snap ? { type: snap.type, ref: snap.ref } : null,
    workDir:  _workDir,
    prompt:   prompt.slice(0, 100),
  });

  // ── 6. Execute ───────────────────────────────────────────────────────────────
  let result;
  if (executor === 'local_gamma4') {
    result = await lmstudio.chat({ prompt, systemPrompt, history });
  } else {
    result = await claudeCode.run({ prompt, profile, readOnly, workDir: _workDir, sessionId, forceNew });
  }

  // ── 7. Audit: task end ───────────────────────────────────────────────────────
  log({
    event:     'task_end',
    profile,   executor,
    ok:        result.ok,
    latencyMs: result.latencyMs,
    error:     result.error  || null,
    sessionId: result.sessionId || null,
  });

  // ── 8. Upgrade suggestion ────────────────────────────────────────────────────
  const upgrade = suggestUpgrade(profile, result);
  if (upgrade) result.suggestUpgrade = upgrade;

  return {
    ...result,
    profile,
    executor,
    snapshot: snap,
  };
}

module.exports = { execute };
