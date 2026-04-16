'use strict';
/**
 * audit_log.js
 * Append-only JSONL audit trail at gamma-v1/logs/audit.jsonl
 * Each entry: { ts, event, profile, executor, ... }
 */
const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

/**
 * Append one audit entry.
 * @param {object} entry — arbitrary fields; ts is auto-added
 */
function log(entry) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Audit failure must never crash the main flow
  }
}

/**
 * Read the last N audit entries.
 * @param {number} [n=20]
 * @returns {object[]}
 */
function recent(n = 20) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .slice(-n)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { log, recent, LOG_FILE };
