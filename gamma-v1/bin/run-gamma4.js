#!/usr/bin/env node
'use strict';
/**
 * bin/run-gamma4.js
 * Shortcut: always routes to local_gamma4 (LM Studio), bypassing auto-classification.
 * Usage: node bin/run-gamma4.js <task>
 */
require('../lib/load-env');
process.argv.splice(2, 0, '--executor', 'local_gamma4');
require('./myclaw.js');
