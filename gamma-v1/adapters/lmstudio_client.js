'use strict';
/**
 * lmstudio_client.js
 * Adapter for LM Studio's OpenAI-compatible local endpoint.
 * Config via env: LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, LMSTUDIO_TIMEOUT
 */
const http  = require('http');
const https = require('https');

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL    = 'local-model';
const DEFAULT_TIMEOUT  = 60000;

function httpRequest(baseUrl, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Parse base URL separately; append pathname directly to avoid URL resolution
    // dropping the base path (e.g. new URL('/chat', 'http://h:1234/v1') → /chat, not /v1/chat)
    const base = new URL(baseUrl);
    const lib  = base.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    // Remove trailing slash from base.pathname, ensure pathname starts with /
    const basePath = base.pathname.replace(/\/$/, '');
    const fullPath = basePath + (pathname.startsWith('/') ? pathname : '/' + pathname);

    const req = lib.request({
      hostname: base.hostname,
      port:     base.port || (base.protocol === 'https:' ? 443 : 80),
      path:     fullPath,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.error?.message || raw.slice(0, 200)}`));
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
        req.destroy(new Error(`LM Studio request timed out after ${timeoutMs}ms`));
      });
    }

    req.write(data);
    req.end();
  });
}

/**
 * Quick reachability check — GETs /v1/models, returns true/false.
 */
async function healthCheck(baseUrl) {
  const _base = baseUrl || process.env.LMSTUDIO_BASE_URL || DEFAULT_BASE_URL;
  return new Promise((resolve) => {
    try {
      const url = new URL('/v1/models', _base);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(url.toString(), (res) => {
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

/**
 * Send a chat completion request to LM Studio.
 *
 * @param {object} opts
 * @param {string}   opts.prompt        — user message (appended after history)
 * @param {string}  [opts.systemPrompt] — optional system message
 * @param {Array}   [opts.history]      — prior turns [{role,content},...] for multi-turn
 * @param {string}  [opts.model]        — overrides LMSTUDIO_MODEL
 * @param {number}  [opts.temperature]  — default 0.3
 * @param {number}  [opts.maxTokens]    — default 2048
 * @param {string}  [opts.baseUrl]      — overrides LMSTUDIO_BASE_URL
 * @param {number}  [opts.timeout]      — ms, overrides LMSTUDIO_TIMEOUT
 * @returns {Promise<{ok, executor, model, content, usage, latencyMs, error?}>}
 */
async function chat({
  prompt,
  systemPrompt = null,
  history      = [],
  model        = null,
  temperature  = 0.3,
  maxTokens    = 8192,   // 大推理模型需要足夠空間完成 thinking + answer
  baseUrl      = null,
  timeout      = null,
} = {}) {
  const _base    = baseUrl  || process.env.LMSTUDIO_BASE_URL || DEFAULT_BASE_URL;
  const _model   = model    || process.env.LMSTUDIO_MODEL    || DEFAULT_MODEL;
  const _timeout = timeout  || parseInt(process.env.LMSTUDIO_TIMEOUT || '0') || DEFAULT_TIMEOUT;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  // Inject conversation history before current prompt
  for (const turn of history) messages.push(turn);
  messages.push({ role: 'user', content: prompt });

  const body = {
    model:      _model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream:     false,
  };

  const startMs = Date.now();
  try {
    const res      = await httpRequest(_base, '/chat/completions', body, _timeout);
    const msg      = res.choices?.[0]?.message ?? {};
    // Reasoning models put thinking in reasoning_content; final answer in content.
    // Fall back to reasoning_content when content is empty (model ran out of tokens for answer).
    const content  = msg.content || msg.reasoning_content || '';
    const thinking = msg.reasoning_content && msg.content ? msg.reasoning_content : null;

    if (!content.trim()) {
      return {
        ok:        false,
        executor:  'local_gamma4',
        error:     'Model returned empty content (model may still be loading, retry in a moment)',
        latencyMs: Date.now() - startMs,
      };
    }

    return {
      ok:        true,
      executor:  'local_gamma4',
      model:     res.model || _model,
      content,
      thinking,  // present only when both fields exist
      usage:     res.usage || null,
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      ok:        false,
      executor:  'local_gamma4',
      error:     err.message,
      latencyMs: Date.now() - startMs,
    };
  }
}

module.exports = { chat, healthCheck };
