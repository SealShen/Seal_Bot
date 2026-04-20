'use strict';
/**
 * lmstudio_client.js
 * OpenAI-compatible chat adapter with Gemini cascade + local fallback.
 *
 * Cascade order (when no explicit model given):
 *   gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash → gemini-2.0-flash-lite
 *   → local (FALLBACK_*)
 * Override via GEMINI_CASCADE_MODELS env (comma-separated).
 *
 * Shared sticky state with C:/Users/leond/.claude/hooks/prompt_router.py:
 *   ~/.claude/gemini-cascade-state.json — layers that 429'd today are skipped
 *   until PT midnight. Both the hook classifier and this MCP adapter contribute
 *   to and consume this state so the cascade learns once per day.
 *
 * Primary config:  LMSTUDIO_BASE_URL / LMSTUDIO_API_KEY / LMSTUDIO_TIMEOUT (model names from cascade list)
 * Fallback config: FALLBACK_BASE_URL / FALLBACK_MODEL / FALLBACK_API_KEY / FALLBACK_TIMEOUT
 *
 * Fallback triggers only on retryable errors (timeout / network / 429 / 5xx / empty content).
 * Hard errors like 401/403/400 short-circuit cascade (misconfiguration won't heal layer-by-layer).
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL    = 'local-model';
const DEFAULT_TIMEOUT  = 60000;

const DEFAULT_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

const CASCADE_STATE_PATH = path.join(os.homedir(), '.claude', 'gemini-cascade-state.json');

function todayPtStr() {
  // PT = UTC-8; use millisecond shift then format YYYY-MM-DD
  const now = new Date();
  const pt = new Date(now.getTime() - 8 * 3600 * 1000);
  return pt.toISOString().slice(0, 10);
}

function loadCascadeState() {
  const today = todayPtStr();
  try {
    const raw = fs.readFileSync(CASCADE_STATE_PATH, 'utf-8');
    const state = JSON.parse(raw);
    if (state.date_pt !== today) {
      return { date_pt: today, dead_layers: [] };
    }
    if (!Array.isArray(state.dead_layers)) state.dead_layers = [];
    return state;
  } catch {
    return { date_pt: today, dead_layers: [] };
  }
}

function saveCascadeState(state) {
  try {
    const dir = path.dirname(CASCADE_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CASCADE_STATE_PATH, JSON.stringify(state), 'utf-8');
  } catch { /* logging failure must not block */ }
}

function markLayerDead(state, layer) {
  if (!state.dead_layers.includes(layer)) {
    state.dead_layers.push(layer);
    saveCascadeState(state);
  }
}

function getCascadeList() {
  const envList = process.env.GEMINI_CASCADE_MODELS;
  if (envList && envList.trim()) {
    return envList.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_CASCADE.slice();
}

function httpRequest(baseUrl, pathname, body, timeoutMs, apiKey) {
  return new Promise((resolve, reject) => {
    // Parse base URL separately; append pathname directly to avoid URL resolution
    // dropping the base path (e.g. new URL('/chat', 'http://h:1234/v1') → /chat, not /v1/chat)
    const base = new URL(baseUrl);
    const lib  = base.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const basePath = base.pathname.replace(/\/$/, '');
    const fullPath = basePath + (pathname.startsWith('/') ? pathname : '/' + pathname);

    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const req = lib.request({
      hostname: base.hostname,
      port:     base.port || (base.protocol === 'https:' ? 443 : 80),
      path:     fullPath,
      method:   'POST',
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}: ${json.error?.message || raw.slice(0, 200)}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);

    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
    }

    req.write(data);
    req.end();
  });
}

/**
 * Quick reachability check — GETs /models on primary, returns true/false.
 */
async function healthCheck(baseUrl) {
  const _base = baseUrl || process.env.LMSTUDIO_BASE_URL || DEFAULT_BASE_URL;
  return new Promise((resolve) => {
    try {
      const url = new URL(_base.replace(/\/$/, '') + '/models');
      const lib = url.protocol === 'https:' ? https : http;
      const _apiKey = process.env.LMSTUDIO_API_KEY;
      const reqOpts = { headers: _apiKey ? { 'Authorization': `Bearer ${_apiKey}` } : {} };
      const req = lib.get(url.toString(), reqOpts, (res) => {
        resolve(res.statusCode < 400);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

function _shouldFallback(errMsg) {
  if (!errMsg) return false;
  const s = String(errMsg);
  // Blacklist: these indicate misconfiguration (wrong key, bad request) — fallback won't help.
  if (/HTTP 40[013]/i.test(s)) return false;
  // Everything else (timeout / network / 404 / 408 / 429 / 5xx / non-JSON / empty content) retries on fallback.
  return true;
}

async function _chatOnce(config, messages, temperature, maxTokens) {
  const body = {
    model:      config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream:     false,
  };
  const startMs = Date.now();
  try {
    const res      = await httpRequest(config.baseUrl, '/chat/completions', body, config.timeout, config.apiKey);
    const msg      = res.choices?.[0]?.message ?? {};
    // Reasoning models put thinking in reasoning_content; final answer in content.
    const content  = msg.content || msg.reasoning_content || '';
    const thinking = msg.reasoning_content && msg.content ? msg.reasoning_content : null;

    if (!content.trim()) {
      return {
        ok:        false,
        executor:  config.label,
        error:     'Model returned empty content (model may still be loading, retry in a moment)',
        latencyMs: Date.now() - startMs,
      };
    }
    return {
      ok:        true,
      executor:  config.label,
      model:     res.model || config.model,
      content,
      thinking,
      usage:     res.usage || null,
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      ok:        false,
      executor:  config.label,
      error:     err.message,
      latencyMs: Date.now() - startMs,
    };
  }
}

/**
 * Send a chat completion. Tries primary first; falls back to FALLBACK_* config
 * on retryable failures if configured.
 *
 * @returns {Promise<{ok, executor, model, content, thinking, usage, latencyMs, error?, fellBackFrom?}>}
 */
async function chat({
  prompt,
  systemPrompt = null,
  history      = [],
  model        = null,
  temperature  = 0.3,
  maxTokens    = 8192,
  baseUrl      = null,
  timeout      = null,
} = {}) {
  const primary = {
    baseUrl: baseUrl || process.env.LMSTUDIO_BASE_URL || DEFAULT_BASE_URL,
    model:   model   || process.env.LMSTUDIO_MODEL    || DEFAULT_MODEL,
    apiKey:  process.env.LMSTUDIO_API_KEY || null,
    timeout: timeout || parseInt(process.env.LMSTUDIO_TIMEOUT || '0') || DEFAULT_TIMEOUT,
    label:   'primary',
  };

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const turn of history) messages.push(turn);
  messages.push({ role: 'user', content: prompt });

  const primaryRes = await _chatOnce(primary, messages, temperature, maxTokens);
  if (primaryRes.ok) return primaryRes;

  const fallbackBase = process.env.FALLBACK_BASE_URL;
  if (!fallbackBase || !_shouldFallback(primaryRes.error)) {
    return primaryRes;
  }

  const fallback = {
    baseUrl: fallbackBase,
    model:   process.env.FALLBACK_MODEL || DEFAULT_MODEL,
    apiKey:  process.env.FALLBACK_API_KEY || null,
    timeout: parseInt(process.env.FALLBACK_TIMEOUT || '0') || DEFAULT_TIMEOUT,
    label:   'fallback',
  };

  const fallbackRes = await _chatOnce(fallback, messages, temperature, maxTokens);
  if (fallbackRes.ok) {
    return { ...fallbackRes, fellBackFrom: primaryRes.error };
  }
  // Both failed — return combined error; primary error first (usually the actionable one).
  return {
    ok:        false,
    executor:  'both_failed',
    error:     `primary: ${primaryRes.error || 'unknown'}; fallback: ${fallbackRes.error || 'unknown'}`,
    latencyMs: (primaryRes.latencyMs || 0) + (fallbackRes.latencyMs || 0),
  };
}

module.exports = { chat, healthCheck };
