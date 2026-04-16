#!/usr/bin/env node
'use strict';
/**
 * bin/run-claude-code.js
 * Shortcut: always routes to local_claude_code, bypassing auto-classification.
 * Usage: node bin/run-claude-code.js <task>
 */
require('../lib/load-env');
process.argv.splice(2, 0, '--executor', 'local_claude_code');
require('./myclaw.js');
