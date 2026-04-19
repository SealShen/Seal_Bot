#!/usr/bin/env node
'use strict';
/**
 * MCP stdio server exposing local Gemma (LM Studio) as a tool for Claude Code.
 * Protocol: JSON-RPC 2.0 over stdin/stdout, newline-delimited.
 *
 * Tools:
 *   - gemma_chat: run a one-shot prompt on local Gemma
 *   - gemma_health: quick reachability check
 *
 * All logging goes to stderr to keep stdout reserved for protocol frames.
 */

const fs = require('fs');
const path = require('path');

// Load gamma-v1/.env into process.env at startup so FALLBACK_* and LMSTUDIO_* vars
// are available regardless of how the MCP server was launched (direct / Claude Code).
(function loadDotenv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      const [, k, v] = m;
      if (!(k in process.env)) process.env[k] = v.replace(/^['"]|['"]$/g, '');
    }
  } catch {}
})();

const { chat, healthCheck } = require(path.join(__dirname, 'adapters', 'lmstudio_client.js'));

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'gemma-local', version: '0.1.0' };
const USAGE_LOG = path.join(__dirname, 'gemma_usage.log');
const CONTENT_LOG = path.join(__dirname, 'gemma_content.log');
const PLAYBOOK_PATH = path.join(__dirname, 'gemma_playbook.md');
// Counterfactual price: if Claude had produced these tokens itself.
// Sonnet 4.6 output = $15 / 1M tokens.
const SONNET_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

function appendUsageLog(entry) {
  try { fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n'); } catch (e) { log('usage log write failed', e.message); }
}

function appendContentLog(entry) {
  try { fs.appendFileSync(CONTENT_LOG, JSON.stringify(entry) + '\n'); } catch (e) { log('content log write failed', e.message); }
}

// Live-read playbook per call so distill output takes effect without MCP restart.
function readPlaybook() {
  try {
    const raw = fs.readFileSync(PLAYBOOK_PATH, 'utf8').trim();
    return raw || null;
  } catch { return null; }
}

function readUsageLog() {
  try {
    const raw = fs.readFileSync(USAGE_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const TOOLS = [
  {
    name: 'gemma_chat',
    description:
      'Run a one-shot prompt against the local Gemma model via LM Studio. ' +
      'Prefer this over self-generating output for low-risk mechanical text tasks: ' +
      'summarization, translation, reformatting, keyword extraction, simple classification, ' +
      'template filling. Do NOT use for code generation, architectural decisions, tool-use ' +
      'planning, or tasks requiring judgment across many signals. Returns the model content ' +
      'as a plain string. Local, zero token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User prompt for Gemma.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        max_tokens: { type: 'number', description: 'Optional cap on output tokens. Default 2048.' },
        temperature: { type: 'number', description: 'Optional sampling temperature. Default 0.3.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemma_health',
    description: 'Check whether the local Gemma (LM Studio) endpoint is reachable. Returns {ok: boolean}.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gemma_stats',
    description:
      'Read aggregated Gemma delegation stats from the local usage log. ' +
      'Returns total calls, total prompt/completion tokens handled by Gemma, ' +
      'and estimated USD saved (counterfactual: if Claude Sonnet had produced those completion tokens). ' +
      'Optional `since` filter (ISO date or unix ms).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp or unix ms; only count entries after this.' },
      },
    },
  },
];

function log(...args) { try { process.stderr.write('[gemma-mcp] ' + args.join(' ') + '\n'); } catch {} }

function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { log('send failed', e.message); }
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

async function handleToolCall(name, args) {
  if (name === 'gemma_chat') {
    const { prompt, system, max_tokens, temperature } = args || {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { isError: true, content: [{ type: 'text', text: 'Missing required parameter: prompt (non-empty string).' }] };
    }
    const playbook = readPlaybook();
    const mergedSystem = [playbook, system].filter(Boolean).join('\n\n---\n\n') || null;
    const res = await chat({
      prompt,
      systemPrompt: mergedSystem,
      maxTokens: typeof max_tokens === 'number' ? max_tokens : undefined,
      temperature: typeof temperature === 'number' ? temperature : undefined,
    });
    if (!res.ok) {
      appendUsageLog({ ts: Date.now(), ok: false, error: res.error, latencyMs: res.latencyMs, prompt_len: prompt.length });
      return { isError: true, content: [{ type: 'text', text: `Gemma error: ${res.error || 'unknown'}` }] };
    }
    appendUsageLog({
      ts: Date.now(),
      ok: true,
      model: res.model,
      executor: res.executor,
      fallback_used: !!res.fellBackFrom,
      primary_error: res.fellBackFrom || null,
      latencyMs: res.latencyMs,
      prompt_len: prompt.length,
      content_len: res.content.length,
      prompt_tokens: res.usage?.prompt_tokens ?? null,
      completion_tokens: res.usage?.completion_tokens ?? null,
      playbook_used: playbook ? playbook.length : 0,
    });
    appendContentLog({
      ts: Date.now(),
      system: system || null,
      prompt,
      response: res.content,
      model: res.model,
      executor: res.executor,
      fallback_used: !!res.fellBackFrom,
      prompt_tokens: res.usage?.prompt_tokens ?? null,
      completion_tokens: res.usage?.completion_tokens ?? null,
    });
    const fbMarker = res.fellBackFrom ? ' FALLBACK' : '';
    const footer = res.usage
      ? `\n\n---\n[gemma usage: in=${res.usage.prompt_tokens ?? '?'} out=${res.usage.completion_tokens ?? '?'} latency=${res.latencyMs}ms model=${res.model}${fbMarker}]`
      : `\n\n---\n[gemma latency=${res.latencyMs}ms model=${res.model}${fbMarker}]`;
    return { content: [{ type: 'text', text: res.content + footer }] };
  }
  if (name === 'gemma_health') {
    const reachable = await healthCheck();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: reachable }) }] };
  }
  if (name === 'gemma_stats') {
    let sinceMs = 0;
    const since = args?.since;
    if (typeof since === 'string' && since) {
      const n = Number(since);
      sinceMs = Number.isFinite(n) && n > 0 ? n : Date.parse(since) || 0;
    } else if (typeof since === 'number') {
      sinceMs = since;
    }
    const rows = readUsageLog().filter(r => (r.ts || 0) >= sinceMs);
    const ok_rows = rows.filter(r => r.ok);
    const total_prompt = ok_rows.reduce((a, r) => a + (r.prompt_tokens || 0), 0);
    const total_completion = ok_rows.reduce((a, r) => a + (r.completion_tokens || 0), 0);
    const usd_saved = total_completion * SONNET_OUTPUT_USD_PER_TOKEN;
    const first_ts = rows.length ? rows[0].ts : null;
    const last_ts = rows.length ? rows[rows.length - 1].ts : null;
    const summary = {
      total_calls: rows.length,
      successful_calls: ok_rows.length,
      failed_calls: rows.length - ok_rows.length,
      total_prompt_tokens: total_prompt,
      total_completion_tokens: total_completion,
      estimated_usd_saved_vs_sonnet: Number(usd_saved.toFixed(6)),
      first_call: first_ts ? new Date(first_ts).toISOString() : null,
      last_call: last_ts ? new Date(last_ts).toISOString() : null,
      counterfactual_rate: '$15/1M output tokens (Sonnet 4.6)',
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
}

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }
    if (method === 'tools/list') {
      return ok(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await handleToolCall(name, args);
      return ok(id, result);
    }
    if (method === 'ping') {
      return ok(id, {});
    }
    if (method === 'shutdown') {
      ok(id, {});
      process.exit(0);
      return;
    }
    if (id !== undefined) err(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (id !== undefined) err(id, -32603, 'Internal error', { detail: e.message });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch (e) { log('parse error', e.message, trimmed.slice(0, 120)); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => { process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`started (pid=${process.pid})`);
