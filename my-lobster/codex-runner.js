// codex-runner.js
// 封裝 codex exec --json 的 spawn / JSONL 解析
// 由 bot.js 的 codex 模式與 /codex 單次指令呼叫
//
// 事件 schema（觀察結果）：
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started"|"item.completed","item":{"id":"item_N","type":"agent_message","text":"..."}}
//   {"type":"item.started"|"item.completed","item":{"id":"item_N","type":"command_execution","command":"...","aggregated_output":"...","exit_code":N,"status":"..."}}
//   {"type":"turn.completed","usage":{...}}

const { spawn } = require('child_process');

// 把單一 item 物件轉成顯示字串
function formatItem(item) {
  if (!item) return '';
  if (item.type === 'agent_message') {
    return (item.text || '').trim();
  }
  if (item.type === 'command_execution') {
    const cmd = (item.command || '').trim();
    const out = (item.aggregated_output || '').trim();
    const exit = item.exit_code;
    const head = `\`\`\`\n$ ${cmd}\n`;
    const tail = exit != null && exit !== 0 ? `\n(exit ${exit})` : '';
    const body = out ? out.slice(-1500) : '(running…)';
    return `${head}${body}${tail}\n\`\`\``;
  }
  return '';
}

function runCodex({ prompt, workingDir, autoMode = false, model = null, onProgress = null, onProc = null }) {
  return new Promise((resolve) => {
    const sandbox = autoMode ? 'danger-full-access' : 'workspace-write';
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', sandbox];
    if (autoMode) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('-m', model);

    const env = { ...process.env };
    // 不要把 Claude 的 API key 帶給 codex；codex 用自己的 ~/.codex auth
    delete env.ANTHROPIC_API_KEY;

    const proc = spawn('codex', args, {
      cwd: workingDir,
      windowsHide: true,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    if (onProc) onProc(proc);

    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();

    let lineBuf = '';
    let stderrBuf = '';
    let threadId = null;
    // item.id → 顯示字串；rebuildOutput 時依 id 順序串接
    const items = new Map(); // Map<itemId, { order, text }>
    let order = 0;
    let lastEmittedSnapshot = '';

    const rebuildSnapshot = () => {
      const sorted = [...items.values()].sort((a, b) => a.order - b.order);
      return sorted.map(x => x.text).filter(Boolean).join('\n\n');
    };

    const handleEvent = (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'thread.started' && ev.thread_id) {
        threadId = ev.thread_id;
        return;
      }
      if (ev.type === 'item.started' || ev.type === 'item.completed') {
        const item = ev.item;
        if (!item || !item.id) return;
        const text = formatItem(item);
        if (!text) return;
        const existing = items.get(item.id);
        if (existing) {
          existing.text = text;
        } else {
          items.set(item.id, { order: order++, text });
        }
        const snapshot = rebuildSnapshot();
        if (snapshot !== lastEmittedSnapshot) {
          lastEmittedSnapshot = snapshot;
          if (onProgress) onProgress(snapshot);
        }
      }
    };

    const consumeLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        handleEvent(ev);
      } catch {
        // 非 JSON 行（例如 "Reading prompt from stdin..."）忽略
      }
    };

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) consumeLine(line);
    });

    proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

    proc.on('error', (err) => {
      resolve({
        ok: false,
        output: '',
        threadId: null,
        exitCode: -1,
        error: err.code === 'ENOENT' ? 'codex 指令找不到（請確認已安裝 codex-cli）' : err.message,
      });
    });

    proc.on('close', (code) => {
      if (lineBuf.trim()) consumeLine(lineBuf);
      const output = rebuildSnapshot();
      const ok = code === 0;
      resolve({
        ok,
        output: output || (ok ? '(no output)' : ''),
        threadId,
        exitCode: code,
        error: ok ? null : (stderrBuf.trim().slice(-1000) || `exit ${code}`),
      });
    });
  });
}

module.exports = { runCodex };
