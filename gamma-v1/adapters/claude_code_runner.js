'use strict';
/**
 * claude_code_runner.js
 * Wraps the local Claude Code CLI as a spawned subprocess.
 * Uses --print + stream-json output — no API key required, uses subscribed CLI.
 */
const { spawn } = require('child_process');

/**
 * Run a task via local Claude Code CLI.
 *
 * @param {object} opts
 * @param {string}   opts.prompt      — task description
 * @param {string}  [opts.profile]    — profile hint injected into prompt
 * @param {boolean} [opts.readOnly]   — prepend read-only instruction
 * @param {string}  [opts.workDir]    — cwd for the claude process
 * @param {string}  [opts.sessionId]  — resume a specific session
 * @param {boolean} [opts.forceNew]   — start a fresh session
 * @returns {Promise<{ok, executor, content, sessionId, exitCode, latencyMs, error?}>}
 */
async function run({
  prompt,
  profile   = 'implementer',
  readOnly  = false,
  workDir   = null,
  sessionId = null,
  forceNew  = false,
} = {}) {
  const _workDir = workDir || process.env.CLAUDE_WORKING_DIR || process.cwd();

  // Build CLI args
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (!forceNew) {
    if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--continue');
    }
  }

  // Compose full prompt
  const prefix = [
    readOnly ? '[READ-ONLY MODE: inspect and report only — do NOT modify any files]\n' : '',
    `[myclaw-profile:${profile}]\n`,
    '請用繁體中文回答。\n\n',
  ].join('');
  const fullPrompt = prefix + prompt;

  // Env: mark as myclaw-dispatched, hide CLAUDECODE to avoid nested invocation loops
  const env = {
    ...process.env,
    MYCLAW_EXECUTOR: 'claude_code',
    MYCLAW_PROFILE:  profile,
    CLAUDE_FROM_BOT: '0',
  };
  delete env.CLAUDECODE;

  const startMs = Date.now();

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', args, {
        cwd:         _workDir,
        windowsHide: true,
        shell:       true,
        stdio:       ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      return resolve({
        ok:        false,
        executor:  'local_claude_code',
        error:     `Failed to spawn claude: ${err.message}`,
        latencyMs: Date.now() - startMs,
      });
    }

    let output          = '';
    let lineBuf         = '';
    let capturedSession = null;
    let stderrBuf       = '';

    proc.stdin.write(fullPrompt, 'utf8');
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // retain incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) capturedSession = ev.session_id;

          if (ev.type === 'assistant') {
            for (const p of (ev.message?.content || [])) {
              if (p.type === 'text' && p.text) output += p.text + '\n';
              else if (p.type === 'tool_use') {
                const hint = String(Object.values(p.input || {})[0] ?? '').slice(0, 80);
                output += `[tool:${p.name}] ${hint}\n`;
              }
            }
          } else if (ev.type === 'result') {
            const r = String(ev.result ?? '').trim();
            if (r) output += r + '\n';
          }
        } catch {
          // Non-JSON line — pass through as-is
          const trimmed = line.trim();
          if (trimmed) output += trimmed + '\n';
        }
      }
    });

    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    proc.on('error', (err) => {
      resolve({
        ok:        false,
        executor:  'local_claude_code',
        error:     err.code === 'ENOENT'
                     ? 'claude CLI not found — is Claude Code installed and on PATH?'
                     : err.message,
        latencyMs: Date.now() - startMs,
      });
    });

    proc.on('close', (code) => {
      // Flush remaining lineBuf
      if (lineBuf.trim()) {
        try {
          const ev = JSON.parse(lineBuf);
          if (ev.type === 'result') output += String(ev.result ?? '').trim() + '\n';
        } catch {
          output += lineBuf.trim() + '\n';
        }
      }

      const ok = code === 0;
      resolve({
        ok,
        executor:  'local_claude_code',
        content:   output.trim(),
        sessionId: capturedSession,
        exitCode:  code,
        error:     ok ? null : `Exit ${code}${stderrBuf ? ': ' + stderrBuf.slice(0, 300) : ''}`,
        latencyMs: Date.now() - startMs,
      });
    });
  });
}

module.exports = { run };
