'use strict';
/**
 * pre_snapshot.js
 * Creates a reversible snapshot before a write task begins.
 * Strategy:
 *   - git repo with changes → git stash push (records stash ref for rollback)
 *   - git repo, clean       → record HEAD SHA (rollback via reset --hard)
 *   - not a git repo        → log-only, no-op
 */
const { execSync } = require('child_process');

function exec(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function isGitRepo(dir) {
  try { exec('git rev-parse --git-dir', dir); return true; }
  catch { return false; }
}

/**
 * Take a snapshot before a write operation.
 * @param {string} workDir       — working directory
 * @param {string} [taskDesc]    — short label for the stash message
 * @returns {{ ok, type, ref, workDir, timestamp, error? }}
 */
function snapshot(workDir, taskDesc = 'myclaw-task') {
  const result = {
    ok:        false,
    type:      null,
    ref:       null,
    workDir,
    timestamp: new Date().toISOString(),
    error:     null,
  };

  if (!isGitRepo(workDir)) {
    result.type = 'no-git';
    result.ref  = `no-git:${Date.now()}`;
    result.ok   = true;
    return result;
  }

  try {
    // Check for uncommitted changes (tracked + untracked)
    const status = exec('git status --porcelain', workDir);

    if (!status) {
      // Working tree is clean — record HEAD
      result.type = 'git-head';
      result.ref  = exec('git rev-parse HEAD', workDir);
      result.ok   = true;
      return result;
    }

    // Stash everything (including untracked)
    const label = `myclaw-snap:${taskDesc.replace(/[^a-zA-Z0-9_\-]/g, '-').slice(0, 40)}`;
    exec(`git stash push -u -m "${label}"`, workDir);

    // Confirm the stash was created
    const stashRef = exec('git stash list --format=%gd -1', workDir);
    result.type = 'git-stash';
    result.ref  = stashRef || label;
    result.ok   = true;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Roll back to a previously taken snapshot.
 * @param {object} snap — result object from snapshot()
 * @returns {{ ok, note?, error? }}
 */
function rollback(snap) {
  if (!snap || !snap.ok) {
    return { ok: false, error: 'Snapshot was not successful — cannot rollback.' };
  }

  if (snap.type === 'no-git') {
    return { ok: true, note: 'No git repo — manual rollback needed. No files were automatically restored.' };
  }

  try {
    if (snap.type === 'git-stash') {
      // Pop the most recent stash (should be ours since we just pushed it)
      exec('git stash pop', snap.workDir);
      return { ok: true };
    }

    if (snap.type === 'git-head') {
      exec(`git reset --hard ${snap.ref}`, snap.workDir);
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: `Rollback failed: ${err.message}` };
  }

  return { ok: false, error: `Unknown snapshot type: ${snap.type}` };
}

module.exports = { snapshot, rollback };
