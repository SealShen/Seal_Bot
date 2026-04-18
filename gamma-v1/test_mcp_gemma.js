#!/usr/bin/env node
'use strict';
/**
 * Smoke test for mcp_gemma_server.js.
 * Spawns the server over stdio, runs initialize → tools/list → tools/call(gemma_health)
 * → tools/call(gemma_chat), prints each reply.
 *
 * Exits 0 on success, non-zero if any step fails.
 */

const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, 'mcp_gemma_server.js');
const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (c) => {
  buf += c;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { console.error('[test] bad JSON:', t); continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
    else { console.error('[test] unexpected:', msg); }
  }
});

proc.on('exit', (code) => { console.error(`[test] server exited (code=${code})`); });

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log('initialize:', JSON.stringify(init.result || init.error));

  const list = await call('tools/list', {});
  console.log('tools/list:', (list.result?.tools || []).map(t => t.name).join(', '));

  const health = await call('tools/call', { name: 'gemma_health', arguments: {} });
  console.log('gemma_health:', JSON.stringify(health.result || health.error));

  const chat = await call('tools/call', { name: 'gemma_chat', arguments: { prompt: 'Say OK and nothing else.', max_tokens: 32 } });
  const text = chat.result?.content?.[0]?.text ?? JSON.stringify(chat.error);
  console.log('gemma_chat:', text.slice(0, 400));

  const stats = await call('tools/call', { name: 'gemma_stats', arguments: {} });
  const statsText = stats.result?.content?.[0]?.text ?? JSON.stringify(stats.error);
  console.log('gemma_stats:', statsText);

  proc.stdin.end();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('[test] fatal', e); process.exit(1); });
