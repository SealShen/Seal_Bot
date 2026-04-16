'use strict';
/**
 * route_profile.js
 * Maps a profile to an executor + read-only flag.
 * Supports explicit executor override and upgrade suggestions.
 */

// Default executor per profile
const PROFILE_EXECUTORS = {
  explorer:    'local_gamma4',       // read-only exploration → cheap local model
  architect:   'local_gamma4',       // design drafting → local model, escalate if needed
  implementer: 'local_claude_code',  // file writes → Claude Code
  security:    'local_gamma4',       // read-only audit → local model
};

// Profiles that must NOT write files
const READ_ONLY_PROFILES = new Set(['explorer', 'security']);

// Profiles that need a pre-write snapshot
const SNAP_PROFILES = new Set(['implementer', 'architect']);

/**
 * Resolve routing for a given profile.
 * @param {string}  profile
 * @param {string} [overrideExecutor] — explicit executor from CLI/bot
 * @returns {{ executor: string, readOnly: boolean, needsSnap: boolean, profile: string }}
 */
function route(profile, overrideExecutor = null) {
  const executor  = overrideExecutor || PROFILE_EXECUTORS[profile] || 'local_claude_code';
  const readOnly  = READ_ONLY_PROFILES.has(profile);
  const needsSnap = SNAP_PROFILES.has(profile) && executor === 'local_claude_code';

  return { executor, readOnly, needsSnap, profile };
}

/**
 * Suggest an upgrade profile based on execution result quality.
 * @param {string} profile
 * @param {object} result  — result from adapter
 * @returns {string|null}  — suggested new profile, or null
 */
function suggestUpgrade(profile, result) {
  if (!result.ok) {
    // Execution failed — escalate
    if (profile === 'explorer')   return 'architect';
    if (profile === 'architect')  return 'implementer';
  }
  // Response too short to be useful for explorer (< 150 chars = likely a one-liner)
  if (profile === 'explorer' && result.ok && (result.content || '').trim().length < 150) {
    return 'architect';
  }
  return null;
}

module.exports = { route, suggestUpgrade };
