'use strict';
/**
 * lib/load-env.js
 * Minimal .env loader — no dependencies.
 * Reads KEY=VALUE lines, skips comments and blanks.
 * Only sets values that are NOT already in process.env.
 */
const fs   = require('fs');
const path = require('path');

function loadEnv(envPath) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let   val = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env not found or unreadable — silently ignore
  }
}

// Load gamma-v1/.env on require
loadEnv(path.join(__dirname, '..', '.env'));

module.exports = { loadEnv };
