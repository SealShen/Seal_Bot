require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

const TMP_WEBFETCH  = path.join(os.tmpdir(), 'claude_webfetch');
const { verify: totpVerify, generateSecret, generateURI } = require('otplib');
const QRCode = require('qrcode');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN           = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.MY_TELEGRAM_USER_ID, 10);
const DEFAULT_DIR     = process.env.CLAUDE_WORKING_DIR || path.join(os.homedir(), 'MyClaw');
const SESSION_TTL_MS  = 8 * 60 * 60 * 1000; // 驗證後有效 8 小時

// 白名單：從 .env 讀取，格式 ALLOWED_DIRS=dir1;dir2（分號分隔），預設同 CLAUDE_WORKING_DIR
const TG_MEDIA_DIR  = path.join(DEFAULT_DIR, '..', '_tg_media');
const _extraDirs    = (process.env.ALLOWED_DIRS || '').split(';').map(s => s.trim()).filter(Boolean);
const ALLOWED_DIRS  = [
  DEFAULT_DIR,
  ..._extraDirs,
  TG_MEDIA_DIR,
];

const STREAM_INTERVAL = 3000;
const MAX_LEN         = 3800;
const ENV_PATH        = path.join(__dirname, '.env');

if (!TOKEN)           throw new Error('TELEGRAM_TOKEN not set in .env');
if (!ALLOWED_USER_ID) throw new Error('MY_TELEGRAM_USER_ID not set in .env');

// ── TOTP ──────────────────────────────────────────────────────────────────────
// 第一次啟動若無 TOTP_SECRET，自動產生並寫入 .env
let TOTP_SECRET = process.env.TOTP_SECRET;
if (!TOTP_SECRET) {
  TOTP_SECRET = generateSecret();
  fs.appendFileSync(ENV_PATH, `\nTOTP_SECRET=${TOTP_SECRET}\n`);
  console.log('已產生新的 TOTP_SECRET 並寫入 .env，請重啟 Bot 後用 /setup 掃描 QR code');
}

// 驗證 session：記錄通過驗證的時間
let authedAt = null;
const isAuthed = () => authedAt && (Date.now() - authedAt) < SESSION_TTL_MS;

const bot = new TelegramBot(TOKEN, { polling: true });
let currentProc     = null;
let newSession      = false;
let workingDir      = DEFAULT_DIR;
let currentSessionId = null; // null = --continue, string = --resume <id>

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let recentSessions = (() => {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return []; }
})();

// ── Security ──────────────────────────────────────────────────────────────────
const BLOCKED_RULES = [
  // 系統安全
  { pattern: /windows[\\/]system32|syswow64/i,              reason: '禁止存取 Windows 系統目錄' },
  { pattern: /format\s+[a-z]:/i,                            reason: '禁止格式化磁碟' },
  { pattern: /netsh\s|reg\s+(add|delete)|sc\s+create/i,     reason: '禁止修改系統設定' },
  { pattern: /rm\s+-rf\s+[/\\]|del\s+\/[sf]+\s+[a-z]:\\/i, reason: '禁止刪除根目錄' },

  // 憑證與金鑰存取
  { pattern: /\.(env|pem|key|p12|pfx)\b|id_rsa/i,           reason: '禁止存取憑證／金鑰檔案' },
  { pattern: /printenv|Get-ChildItem\s+env:|echo\s+%\w*(key|token|secret)\w*%/i, reason: '禁止列印環境變數' },
  { pattern: /process\.env\.\w*(key|token|secret|password|api)\w*/i, reason: '禁止讀取憑證環境變數' },

  // 禁止直接連線外部服務（需透過 MCP）
  { pattern: /curl\s+https?:\/\/(?!localhost|127\.0\.0\.1)/i,  reason: '禁止直接呼叫外部 API，請使用 MCP' },
  { pattern: /wget\s+https?:\/\/(?!localhost|127\.0\.0\.1)/i,  reason: '禁止直接呼叫外部 API，請使用 MCP' },
  {
    pattern: /(?:openai|anthropic|googleapis|api\.github|slack\.com\/api|discord\.com\/api|api\.notion|atlassian\.net\/rest)\.com/i,
    reason: '禁止直接連線外部服務 API，請透過已設定的 MCP',
  },
  {
    pattern: /new\s+OpenAI|new\s+Anthropic|axios\.(?:get|post)\s*\(\s*['"]https?:\/\/(?!localhost)/i,
    reason: '禁止在 Bot 中直接建立外部 API 連線，請透過 MCP',
  },
];

const DANGEROUS_RULES = [
  { pattern: /\brm\s+-rf\b|rimraf|rmdir\s+\/s\b|del\s+\/[sf]/i, reason: '⚠️ 刪除檔案或目錄（不可回復）' },
  { pattern: /git\s+push\s+(.*\s)?-f\b|git\s+push\s+.*--force/i, reason: '⚠️ Force push 到遠端' },
  { pattern: /drop\s+table|drop\s+database|truncate\s+table/i,   reason: '⚠️ 刪除資料庫資料' },
  { pattern: /git\s+reset\s+--hard/i,                            reason: '⚠️ Git hard reset（丟失未提交變更）' },
  { pattern: /npm\s+publish|yarn\s+publish/i,                    reason: '⚠️ 發布套件到公開 registry' },
];

// 偵測試圖逃出工作目錄的路徑
function isPathEscape(prompt) {
  const escapePattern = /\.\.[/\\]/;
  const absPathPattern = /[a-zA-Z]:[/\\]/g;
  if (escapePattern.test(prompt)) return true;
  const absPaths = prompt.match(absPathPattern) || [];
  return absPaths.some(p => {
    const fullPath = prompt.slice(prompt.indexOf(p));
    return !ALLOWED_DIRS.some(d => fullPath.startsWith(d) || fullPath.toLowerCase().startsWith(d.toLowerCase()));
  });
}

function checkSecurity(prompt) {
  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(prompt)) return { action: 'block', reason: rule.reason };
  }
  if (isPathEscape(prompt)) return { action: 'block', reason: '禁止存取白名單以外的路徑' };
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(prompt)) return { action: 'confirm', reason: rule.reason };
  }
  return { action: 'allow' };
}

// 暫存等待確認的操作
const pendingConfirm = new Map(); // chatId -> prompt

// ── Helpers ───────────────────────────────────────────────────────────────────
const isAllowed = (userId) => userId === ALLOWED_USER_ID;

const safeEdit = (chatId, msgId, text) =>
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' })
     .catch(() => {});

function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(recentSessions), 'utf8'); } catch {}
}

const BOT_ACTIVE_SESSION_FILE = path.join(os.homedir(), '.claude', 'bot-active-session.txt');
function saveBotActiveSession(id) {
  try { fs.writeFileSync(BOT_ACTIVE_SESSION_FILE, id || '', 'utf8'); } catch {}
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s前`;
  if (s < 3600) return `${Math.floor(s / 60)}m前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h前`;
  return `${Math.floor(s / 86400)}d前`;
}

function tail(str, len = MAX_LEN) {
  return str.length > len ? '…' + str.slice(-len) : str;
}

// ── Stream-JSON parser ────────────────────────────────────────────────────────
function parseStreamLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return line.trim() || null; }

  const t = ev.type;

  if (t === 'assistant') {
    const parts = ev.message?.content || [];
    const out = [];
    for (const p of parts) {
      if (p.type === 'text' && p.text) out.push(p.text);
      else if (p.type === 'tool_use') {
        const hint = Object.values(p.input || {})[0] ?? '';
        out.push(`🔧 \`${p.name}\` → \`${String(hint).slice(0, 80)}\``);
      }
    }
    return out.join('\n') || null;
  }

  if (t === 'user') {
    const parts = ev.message?.content || [];
    const out = [];
    for (const p of parts) {
      if (p.type === 'tool_result') {
        let content = p.content ?? '';
        if (Array.isArray(content)) content = content.filter(c => c.type === 'text').map(c => c.text).join(' ');
        content = String(content).slice(0, 120);
        if (content) out.push(`  └ ${content}`);
      }
    }
    return out.join('\n') || null;
  }

  if (t === 'result') return String(ev.result ?? '') || null;

  return null;
}

// ── Core: run claude and stream output ────────────────────────────────────────
async function runClaude(prompt, chatId, forceNew = false, imagePaths = []) {
  const useNewSession = forceNew || newSession;
  newSession = false;
  const statusMsg = await bot.sendMessage(chatId, '⏳ 執行中…');
  const msgId = statusMsg.message_id;

  let output           = '';
  let lastSent         = '';
  let lineBuf          = '';
  let capturedSession  = null;

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (!useNewSession) {
    if (currentSessionId) args.push('--resume', currentSessionId);
    else args.push('--continue');
  }

  const env = { ...process.env, CLAUDE_FROM_BOT: '1', CLAUDE_BOT_CHATID: String(chatId) };
  delete env.CLAUDECODE;

  const proc = spawn('claude', args, {
    cwd: workingDir,
    windowsHide: true,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  const imageSection = imagePaths.length
    ? '\n\n以下是圖片路徑，請用 Read 工具讀取後回答：\n' + imagePaths.map(p => `- ${p}`).join('\n')
    : '';
  const langPrefix = useNewSession ? '請用繁體中文回答。\n\n' : '';
  proc.stdin.write(langPrefix + prompt + imageSection, 'utf8');
  proc.stdin.end();

  currentProc = proc;

  proc.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop(); // 保留尚未結束的最後一行
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const ev = JSON.parse(line); if (ev.session_id) capturedSession = ev.session_id; } catch {}
      const display = parseStreamLine(line);
      if (display) output += display + '\n';
    }
  });

  proc.stderr.on('data', (d) => { output += d.toString(); });

  const startTime = Date.now();
  const timer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (output !== lastSent) {
      await safeEdit(chatId, msgId, `⏳ ${elapsed}s\n\`\`\`\n${tail(output)}\n\`\`\``);
      lastSent = output;
    } else if (!output) {
      await safeEdit(chatId, msgId, `⏳ 思考中… ${elapsed}s`);
    }
  }, STREAM_INTERVAL);

  proc.on('error', async (err) => {
    clearInterval(timer);
    currentProc = null;
    const msg = err.code === 'ENOENT'
      ? '❌ `claude` 指令找不到，請確認 Claude Code 已安裝。'
      : `❌ 錯誤：${err.message}`;
    await safeEdit(chatId, msgId, msg);
  });

  proc.on('close', async (code) => {
    clearInterval(timer);
    currentProc = null;
    // 處理 lineBuf 中剩餘的最後一行
    if (lineBuf.trim()) {
      const display = parseStreamLine(lineBuf);
      if (display) output += display + '\n';
    }

    // 記錄 session（零 token 消耗，純 Node.js）
    if (code === 0 && capturedSession) {
      recentSessions = recentSessions.filter(s => s.id !== capturedSession);
      recentSessions.unshift({
        id: capturedSession,
        summary: prompt.replace(/\s+/g, ' ').slice(0, 40),
        dir: path.basename(workingDir),
        timestamp: Date.now(),
      });
      recentSessions = recentSessions.slice(0, 7);
      currentSessionId = capturedSession;
      saveSessions();
      saveBotActiveSession(capturedSession);
    }

    const icon   = code === 0 ? '✅' : '❌';
    const footer = code !== 0 ? `  _(exit ${code})_` : '';
    const text   = `${icon} 完成${footer}\n\`\`\`\n${tail(output) || '(no output)'}\n\`\`\``;
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId });
    } catch {
      await bot.sendMessage(chatId, text);
    }
  });
}

// ── File download helper ───────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
const MAIN_KEYBOARD = {
  keyboard: [
    ['📂 MyClaw', '📂 Netivism'],
    ['📑 Sessions', '🔄 重啟'],
    ['🛑 取消執行', '📋 目前狀態'],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ── 驗證守衛：所有需要驗證的操作都先過這關 ─────────────────────────────────────
function requireAuth(chatId) {
  if (isAuthed()) return true;
  bot.sendMessage(chatId,
    '🔐 請輸入驗證碼',
    { parse_mode: 'Markdown' }
  );
  return false;
}

// ── Session browser ───────────────────────────────────────────────────────────
const SESSIONS_PER_PAGE = 7;
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// 目錄路徑 → slug（與 Claude Code session 目錄命名規則相同）
function pathToSlug(p) {
  return p.replace(/^([A-Za-z]):[\/\\]/, '$1--').replace(/[\/\\]/g, '-');
}

// 動態建立 DIR_LABEL：ALLOWED_DIRS[0] 顯示為最後一段目錄名，其餘類推
// 可在 .env 用 DIR_LABELS=label1;label2 覆寫（順序對應 ALLOWED_DIRS）
const _dirLabels = (process.env.DIR_LABELS || '').split(';').map(s => s.trim());
const DIR_LABEL  = {};
ALLOWED_DIRS.forEach((d, i) => {
  if (d === TG_MEDIA_DIR) return; // 不加入 session label
  const slug  = pathToSlug(d);
  const label = _dirLabels[i] || path.basename(d);
  DIR_LABEL[slug.toLowerCase()] = label;
});

// 將 workingDir 轉換為對應的顯示標籤
function cwdToLabel(cwd) {
  const slug = pathToSlug(cwd).toLowerCase();
  return DIR_LABEL[slug] || path.basename(cwd);
}

function loadAllSessions(labelFilter = null) {
  const sessions = [];
  try {
    if (!fs.existsSync(PROJECTS_ROOT)) return sessions;
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const label = dir.name in DIR_LABEL ? DIR_LABEL[dir.name] : dir.name;
      if (label === null) continue; // 隱藏
      if (labelFilter && label !== labelFilter) continue; // 只顯示當前目錄
      const dirPath = path.join(PROJECTS_ROOT, dir.name);
      let files;
      try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); }
      catch { continue; }
      for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        const filePath  = path.join(dirPath, file);
        let firstPrompt = null;
        let mtime       = 0;
        try {
          const stat = fs.statSync(filePath);
          mtime = stat.mtimeMs;
          const fileSize = stat.size;
          if (fileSize < 500) continue; // 跳過空 session
          // 讀開頭 8KB + 結尾 4KB，與 VSCode 相同的原始字串搜尋策略
          const fd   = fs.openSync(filePath, 'r');
          const buf  = Buffer.alloc(8192);
          const n    = fs.readSync(fd, buf, 0, 8192, 0);
          const buf2 = Buffer.alloc(4096);
          const tail2Start = Math.max(0, fileSize - 4096);
          const n2   = fs.readSync(fd, buf2, 0, 4096, tail2Start);
          fs.closeSync(fd);
          const head = buf.slice(0, n).toString('utf8');
          const tail = buf2.slice(0, n2).toString('utf8');
          // 原始字串搜尋，與 VSCode extension 邏輯相同（抵抗截斷行）
          const extractField = (chunk, field) => {
            const prefix = `"${field}":"`;
            let i = chunk.indexOf(prefix);
            if (i < 0) return null;
            i += prefix.length;
            let out = '';
            while (i < chunk.length) {
              if (chunk[i] === '\\') { i += 2; continue; }
              if (chunk[i] === '"') break;
              out += chunk[i++];
            }
            return out.trim() || null;
          };
          // 優先順序與 VSCode 完全一致：customTitle > aiTitle > lastPrompt > summary > enqueue
          firstPrompt = (
            extractField(head, 'customTitle') ||
            extractField(tail, 'customTitle') ||
            extractField(head, 'aiTitle')     ||
            extractField(tail, 'aiTitle')     ||
            extractField(tail, 'lastPrompt')  ||
            extractField(head, 'lastPrompt')  ||
            extractField(head, 'summary')     ||
            extractField(tail, 'summary')
          );
          if (firstPrompt) firstPrompt = firstPrompt.replace(/\\n/g, ' ').replace(/\s+/g, ' ').slice(0, 50);
        } catch { continue; }
        sessions.push({ id: sessionId, firstPrompt: firstPrompt || '(無內容)', mtime, project: label });
      }
    }
  } catch {}
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function buildSessionsKeyboard(sessions, page = 0) {
  const totalPages = Math.ceil(sessions.length / SESSIONS_PER_PAGE) || 1;
  const items = sessions.slice(page * SESSIONS_PER_PAGE, (page + 1) * SESSIONS_PER_PAGE);
  const rows = items.map(s => {
    const label = `${s.id === currentSessionId ? '▶ ' : ''}${s.firstPrompt} · ${s.project}`.slice(0, 58);
    return [{ text: label, callback_data: `sess:${s.id}` }];
  });
  const nav = [];
  if (page > 0)              nav.push({ text: '◀', callback_data: `sesspage:${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) nav.push({ text: '▶', callback_data: `sesspage:${page + 1}` });
  if (totalPages > 1) rows.push(nav);
  rows.push([{ text: '🆕 新 Session', callback_data: 'sess:new' }]);
  return { inline_keyboard: rows };
}

function showSessionsKeyboard(chatId) {
  const label = cwdToLabel(workingDir);
  const sessions = loadAllSessions(label);
  if (!sessions.length) {
    bot.sendMessage(chatId, '尚無 Session 記錄。');
    return;
  }
  bot.sendMessage(chatId, `📑 選擇 Session（共 ${sessions.length} 則）：`,
    { reply_markup: buildSessionsKeyboard(sessions, 0) });
}

// ── Command handlers ──────────────────────────────────────────────────────────

// /setup — 產生 QR code 給 Google Authenticator 掃描（不需驗證）
bot.onText(/\/setup/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const botOwner = process.env.BOT_OWNER_NAME || 'owner';
  const otpauth = generateURI({ label: botOwner, secret: TOTP_SECRET, type: 'totp', issuer: 'MyClaw Bot' });
  const qrBuffer = await QRCode.toBuffer(otpauth, { type: 'png', width: 300 });
  await bot.sendPhoto(msg.chat.id, qrBuffer, {
    caption: '📲 用 Google Authenticator 掃描此 QR code\n然後輸入驗證碼登入',
    parse_mode: 'Markdown',
  });
});

// /auth <code> — 輸入 TOTP 驗證碼（不需先驗證）
bot.onText(/\/auth (.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const code = match[1].trim();
  if (totpVerify({ token: code, secret: TOTP_SECRET })) {
    authedAt = Date.now();
    const exp = new Date(authedAt + SESSION_TTL_MS).toLocaleTimeString('zh-TW');
    bot.sendMessage(msg.chat.id,
      `✅ 驗證成功！Session 有效至 ${exp}\n\n` +
      '• 直接傳訊息 → 交給 claude 執行\n' +
      '• 底部按鈕可快速切換目錄、開新 session\n' +
      `\n📁 目前目錄：\`${workingDir}\``,
      { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
    );
  } else {
    bot.sendMessage(msg.chat.id, '❌ 驗證碼錯誤，請重試。');
  }
});

bot.onText(/\/auth$/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, '用法：`/auth 123456`', { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!isAuthed()) {
    bot.sendMessage(msg.chat.id,
      '👋 *Claude Code Bot*\n\n🔐 請輸入驗證碼\n\n首次使用請先 `/setup` 設定 Google Authenticator',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  bot.sendMessage(msg.chat.id,
    '👋 *Claude Code Bot* 已就緒\n\n' +
    '• 直接傳訊息 → 交給 claude 執行\n' +
    '• 底部按鈕可快速切換目錄、開新 session\n' +
    `\n📁 目前目錄：\`${workingDir}\``,
    { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
  );
});

bot.onText(/\/dirs/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  const list = ALLOWED_DIRS.map((d, i) => {
    const mark = d === workingDir ? ' ◀ 目前' : '';
    return `${i + 1}. \`${d}\`${mark}`;
  }).join('\n');
  bot.sendMessage(msg.chat.id, `📂 *可用目錄：*\n${list}\n\n用 \`/cd 編號\` 切換`, { parse_mode: 'Markdown' });
});

bot.onText(/\/cd (.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  const input = match[1].trim();
  const idx = parseInt(input, 10);

  let target;
  if (!isNaN(idx) && idx >= 1 && idx <= ALLOWED_DIRS.length) {
    target = ALLOWED_DIRS[idx - 1];
  } else {
    target = ALLOWED_DIRS.find(d => d.toLowerCase() === input.toLowerCase());
  }

  if (!target) {
    bot.sendMessage(msg.chat.id, '❌ 不在允許清單內，用 `/dirs` 查看可用目錄。', { parse_mode: 'Markdown' });
    return;
  }

  workingDir = target;
  newSession = true; // 切換目錄時開新 session
  bot.sendMessage(msg.chat.id, `✅ 已切換至：\`${workingDir}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/allow (.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  const newDir = match[1].trim();

  if (ALLOWED_DIRS.includes(newDir)) {
    bot.sendMessage(msg.chat.id, `✅ \`${newDir}\` 已在白名單中。`, { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(msg.chat.id,
    `⚠️ 確認要將以下目錄加入白名單？\n\`${newDir}\``,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ 確認允許', callback_data: `allow:${newDir}` },
          { text: '❌ 取消',     callback_data: 'allow:cancel' },
        ]],
      },
    }
  );
});

bot.on('callback_query', async (query) => {
  if (!isAllowed(query.from.id)) return;
  const data    = query.data;
  const chatId  = query.message.chat.id;
  const msgId   = query.message.message_id;
  bot.answerCallbackQuery(query.id);

  // 安全確認
  if (data === 'sec:cancel') {
    pendingConfirm.delete(chatId);
    bot.editMessageText('❌ 已取消。', { chat_id: chatId, message_id: msgId });
    return;
  }
  if (data === 'sec:confirm') {
    const pending = pendingConfirm.get(chatId);
    pendingConfirm.delete(chatId);
    bot.editMessageText('✅ 已確認，執行中…', { chat_id: chatId, message_id: msgId });
    if (pending) await runClaude(pending.prompt, chatId, pending.forceNew, pending.imagePaths || []);
    return;
  }

  // WebFetch 確認
  if (data.startsWith('wf:')) {
    const parts  = data.split(':'); // ['wf', 'allow'|'deny', uuid]
    const action = parts[1];
    const uuid   = parts[2];
    const resFile = path.join(TMP_WEBFETCH, `res_${uuid}.json`);
    try { fs.writeFileSync(resFile, JSON.stringify({ allow: action === 'allow' }), 'utf8'); } catch {}
    bot.editMessageText(
      action === 'allow' ? '✅ 已允許網址存取' : '❌ 已拒絕網址存取',
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {});
    return;
  }

  // 重啟確認
  if (data === 'restart:cancel') {
    bot.editMessageText('❌ 已取消重啟。', { chat_id: chatId, message_id: msgId });
    return;
  }
  if (data === 'restart:confirm') {
    await bot.editMessageText('✅ 確認重啟', { chat_id: chatId, message_id: msgId });
    await bot.sendMessage(chatId, '🔄 Bot 重啟中… 約 2 秒後上線');
    setTimeout(() => process.exit(0), 800); // 等待訊息送出後退出
    return;
  }

  // 無動作（分頁頁碼按鈕）
  if (data === 'noop') return;

  // Session 分頁
  if (data.startsWith('sesspage:')) {
    const page = parseInt(data.slice(9), 10) || 0;
    const sessions = loadAllSessions(cwdToLabel(workingDir));
    bot.editMessageText(
      `📑 選擇 Session（共 ${sessions.length} 則）：`,
      { chat_id: chatId, message_id: msgId, reply_markup: buildSessionsKeyboard(sessions, page) }
    ).catch(() => {});
    return;
  }

  // Session 詳情 / 新 Session
  if (data.startsWith('sess:')) {
    const id = data.slice(5);
    if (id === 'new') {
      currentSessionId = null;
      saveBotActiveSession(null);
      newSession = true;
      bot.editMessageText('🆕 已切換至新 Session', { chat_id: chatId, message_id: msgId }).catch(() => {});
    } else {
      const sessions = loadAllSessions();
      const sess = sessions.find(s => s.id === id);
      const isActive = id === currentSessionId;
      const date = sess ? new Date(sess.mtime).toLocaleString('zh-TW') : '?';
      const detail = [
        `📋 *Session 詳情*`,
        `📁 專案：\`${sess?.project || '?'}\``,
        `🕐 最後更新：${date}`,
        `💬 首句：${sess?.firstPrompt || id}`,
        isActive ? '\n_（目前使用中）_' : '',
      ].filter(Boolean).join('\n');
      bot.editMessageText(detail, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '▶ 繼續此 Session', callback_data: `resume:${id}` }],
          [{ text: '◀ 返回列表',       callback_data: 'sesspage:0'   }],
        ]},
      }).catch(() => {});
    }
    return;
  }

  // Resume session
  if (data.startsWith('resume:')) {
    const id = data.slice(7);
    currentSessionId = id;
    saveBotActiveSession(id);
    newSession = false;
    const sessions = loadAllSessions();
    const sess = sessions.find(s => s.id === id);
    bot.editMessageText(
      `▶ 已切換至 Session：\n${sess?.firstPrompt || id.slice(0, 8) + '…'}`,
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {});
    return;
  }

  // 目錄白名單確認
  if (data === 'allow:cancel') {
    bot.editMessageText('❌ 已取消。', { chat_id: chatId, message_id: msgId });
    return;
  }
  if (data.startsWith('allow:')) {
    const dir = data.slice(6);
    if (!ALLOWED_DIRS.includes(dir)) ALLOWED_DIRS.push(dir);
    bot.editMessageText(`✅ 已新增白名單：\`${dir}\``, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
    });
  }
});

// ── gamma-v1 integration ──────────────────────────────────────────────────────
// 載入 gamma-v1 router（若目錄不存在則靜默跳過，不影響現有流程）
let gammaExecute = null;
try {
  gammaExecute = require('../gamma-v1/index').execute;
} catch {}

// gamma 模式：開啟後，普通訊息走 gamma 而非 Claude Code
let gammaMode = false;
// gamma 對話歷史（in-memory，重啟清空）
let gammaHistory = [];   // [{ role: 'user'|'assistant', content: string }]
const GAMMA_HISTORY_TURNS = 6; // 保留最近 N 輪（user+assistant 各算一）

// /gmode — 切換 gamma 模式
bot.onText(/\/gmode/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  if (!gammaExecute) {
    bot.sendMessage(msg.chat.id, '❌ gamma-v1 未安裝。');
    return;
  }
  gammaMode = !gammaMode;
  gammaHistory = []; // 切換時清空歷史
  bot.sendMessage(msg.chat.id,
    gammaMode
      ? '🤖 *Gamma 模式開啟*\n普通訊息直接傳給 gamma（本機 gemma）\n\n輸入 `/gmode` 可關閉，`/gclear` 清空對話歷史'
      : '💻 *Gamma 模式關閉*\n普通訊息回到 Claude Code',
    { parse_mode: 'Markdown' }
  );
});

// /gclear — 清空 gamma 對話歷史
bot.onText(/\/gclear/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  gammaHistory = [];
  bot.sendMessage(msg.chat.id, '🧹 Gamma 對話歷史已清空。');
});

// /gamma [flags] <task>
// flags 同 bin/myclaw.js：--profile / --executor / --dir / --yes
bot.onText(/\/gamma(.*)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  if (!gammaExecute) {
    bot.sendMessage(msg.chat.id, '❌ gamma-v1 未安裝，請確認 gamma-v1/ 目錄存在。');
    return;
  }

  const raw = (match[1] || '').trim();
  if (!raw) {
    bot.sendMessage(msg.chat.id,
      '*gamma-v1 用法：*\n`/gamma <任務>`\n`/gamma --profile explorer <問題>`\n`/gamma --profile implementer <實作任務>`\n`/gamma --executor local_gamma4 <任務>`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Parse flags from the raw string
  const parts = raw.split(/\s+/);
  let profile     = null;
  let executor    = null;
  let useWorkDir  = workingDir;
  let skipConfirm = false;
  const promptParts = [];
  for (let i = 0; i < parts.length; i++) {
    if      (parts[i] === '--profile'  && parts[i+1]) { profile    = parts[++i]; }
    else if (parts[i] === '--executor' && parts[i+1]) { executor   = parts[++i]; }
    else if (parts[i] === '--dir'      && parts[i+1]) { useWorkDir = parts[++i]; }
    else if (parts[i] === '--yes')                     { skipConfirm = true; }
    else { promptParts.push(parts[i]); }
  }
  const prompt = promptParts.join(' ');

  const statusMsg = await bot.sendMessage(msg.chat.id, '⚙️ gamma 路由中…');
  const msgId = statusMsg.message_id;
  const gammaStart = Date.now();
  const gammaTimer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - gammaStart) / 1000);
    await safeEdit(msg.chat.id, msgId, `⚙️ gamma 執行中… ${elapsed}s`);
  }, 5000);

  try {
    const result = await gammaExecute({ prompt, profile, executor, workDir: useWorkDir, skipConfirm });
    clearInterval(gammaTimer);

    if (result.blocked) {
      await bot.editMessageText(`🚫 *[BLOCKED]*\n${result.reason}`, { chat_id: msg.chat.id, message_id: msgId, parse_mode: 'Markdown' });
      return;
    }
    if (result.needsConfirm) {
      await bot.editMessageText(
        `⚠️ *確認操作*\n${result.confirmReason}\n\n重新傳送：\`/gamma --yes ${raw}\``,
        { chat_id: msg.chat.id, message_id: msgId, parse_mode: 'Markdown' }
      );
      return;
    }

    const icon   = result.ok ? '✅' : '❌';
    const header = `${icon} \`${result.executor}\` / \`${result.profile}\`  ${result.latencyMs}ms`;
    const snap   = result.snapshot ? `\n📸 snapshot: \`${result.snapshot.type}\`` : '';
    const upg    = result.suggestUpgrade ? `\n💡 建議升級：\`--profile ${result.suggestUpgrade}\`` : '';
    const body   = result.content
      ? '\n```\n' + result.content.slice(-3200) + '\n```'
      : (result.error ? '\n' + result.error.slice(0, 300) : '');

    const text = header + snap + upg + body;
    await bot.editMessageText(text, { chat_id: msg.chat.id, message_id: msgId, parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' }));
  } catch (err) {
    clearInterval(gammaTimer);
    await bot.editMessageText(`❌ gamma-v1 錯誤：${err.message}`, { chat_id: msg.chat.id, message_id: msgId })
      .catch(() => {});
  }
});

bot.onText(/\/new (.+)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  await safeRunClaude(match[1].trim(), msg.chat.id, true);
});

bot.onText(/\/new$/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, '🆕 用法：`/new 你的問題`', { parse_mode: 'Markdown' });
});

bot.onText(/^\/restart$/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;

  await bot.sendMessage(msg.chat.id,
    '⚠️ *確認重啟 Bot？*\n\n目前 Session 將結束，約 1 秒後自動重新上線。',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ 確認重啟', callback_data: 'restart:confirm' },
          { text: '❌ 取消',     callback_data: 'restart:cancel'  },
        ]],
      },
    }
  );
});

bot.onText(/^\/sessions$/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  showSessionsKeyboard(msg.chat.id);
});

bot.onText(/\/cancel/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  if (currentProc && !currentProc.killed) {
    currentProc.kill();
    bot.sendMessage(msg.chat.id, '🛑 已送出終止訊號。');
  } else {
    bot.sendMessage(msg.chat.id, '目前沒有執行中的指令。');
  }
});

// ── Security-aware prompt runner ──────────────────────────────────────────────
async function safeRunClaude(prompt, chatId, forceNew = false, imagePaths = []) {
  const check = checkSecurity(prompt);

  if (check.action === 'block') {
    await bot.sendMessage(chatId, `🚫 *指令被封鎖*\n原因：${check.reason}`, { parse_mode: 'Markdown' });
    return;
  }

  if (check.action === 'confirm') {
    pendingConfirm.set(chatId, { prompt, forceNew, imagePaths });
    await bot.sendMessage(chatId,
      `⚠️ *需要確認*\n${check.reason}\n\n確定要執行嗎？`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ 確認執行', callback_data: 'sec:confirm' },
            { text: '❌ 取消',     callback_data: 'sec:cancel'  },
          ]],
        },
      }
    );
    return;
  }

  await runClaude(prompt, chatId, forceNew, imagePaths);
}

// ── Message handler ───────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (msg.text && !msg.text.startsWith('/')) {
    // 若尚未驗證且訊息是 6 位數字，自動當作 /auth 驗證碼
    if (!isAuthed() && /^\d{6}$/.test(msg.text.trim())) {
      const code = msg.text.trim();
      if (totpVerify({ token: code, secret: TOTP_SECRET })) {
        authedAt = Date.now();
        const exp = new Date(authedAt + SESSION_TTL_MS).toLocaleTimeString('zh-TW');
        bot.sendMessage(msg.chat.id,
          `✅ 驗證成功！Session 有效至 ${exp}\n\n` +
          '• 直接傳訊息 → 交給 claude 執行\n' +
          '• 底部按鈕可快速切換目錄、開新 session\n' +
          `\n📁 目前目錄：\`${workingDir}\``,
          { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
        );
      } else {
        bot.sendMessage(msg.chat.id, '❌ 驗證碼錯誤，請重試。');
      }
      return;
    }
    if (!requireAuth(msg.chat.id)) return;
    const text = msg.text.trim();

    // 按鈕處理
    if (text === '📂 MyClaw') {
      workingDir = ALLOWED_DIRS[0];
      newSession = true;
      bot.sendMessage(msg.chat.id, `✅ 已切換至：\`${workingDir}\``, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
      return;
    }
    if (text === '📂 Netivism') {
      workingDir = ALLOWED_DIRS[1] || ALLOWED_DIRS[0];
      newSession = true;
      bot.sendMessage(msg.chat.id, `✅ 已切換至：\`${workingDir}\``, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
      return;
    }
    if (text === '📑 Sessions') {
      showSessionsKeyboard(msg.chat.id);
      return;
    }
    if (text === '🔄 重啟') {
      await bot.sendMessage(msg.chat.id,
        '⚠️ *確認重啟 Bot？*\n\n目前 Session 將結束，約 2 秒後自動重新上線。',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 確認重啟', callback_data: 'restart:confirm' },
              { text: '❌ 取消',     callback_data: 'restart:cancel'  },
            ]],
          },
        }
      );
      return;
    }
    if (text === '🛑 取消執行') {
      if (currentProc && !currentProc.killed) {
        currentProc.kill();
        bot.sendMessage(msg.chat.id, '🛑 已送出終止訊號。', { reply_markup: MAIN_KEYBOARD });
      } else {
        bot.sendMessage(msg.chat.id, '目前沒有執行中的指令。', { reply_markup: MAIN_KEYBOARD });
      }
      return;
    }
    if (text === '📋 目前狀態') {
      const status = currentProc && !currentProc.killed ? '⏳ 執行中' : '✅ 閒置';
      const sessLabel = currentSessionId
        ? `指定 \`${currentSessionId.slice(0, 8)}…\``
        : (newSession ? '新' : '繼續上次');
      const gammaSuffix = gammaMode ? `\n*模式：* 🤖 Gamma（${gammaHistory.length / 2 | 0} 輪歷史）` : '';
      bot.sendMessage(msg.chat.id,
        `*狀態：* ${status}\n*目錄：* \`${workingDir}\`\n*Session：* ${sessLabel}${gammaSuffix}`,
        { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
      );
      return;
    }

    // gamma 模式：普通訊息走 gamma，帶對話歷史
    if (gammaMode && gammaExecute) {
      const statusMsg = await bot.sendMessage(msg.chat.id, '🤖 gamma 思考中…');
      const msgId = statusMsg.message_id;
      const gammaStart = Date.now();
      const gammaTimer = setInterval(async () => {
        const elapsed = Math.floor((Date.now() - gammaStart) / 1000);
        await safeEdit(msg.chat.id, msgId, `🤖 gamma 思考中… ${elapsed}s`);
      }, 5000);

      try {
        const result = await gammaExecute({
          prompt: text,
          history: gammaHistory.slice(-GAMMA_HISTORY_TURNS),
          workDir: workingDir,
        });
        clearInterval(gammaTimer);

        if (result.ok && result.content) {
          // 更新對話歷史
          gammaHistory.push({ role: 'user', content: text });
          gammaHistory.push({ role: 'assistant', content: result.content });
          // 只保留最近 N 輪
          if (gammaHistory.length > GAMMA_HISTORY_TURNS * 2) {
            gammaHistory = gammaHistory.slice(-GAMMA_HISTORY_TURNS * 2);
          }
          const upg = result.suggestUpgrade ? `\n💡 /gamma --profile ${result.suggestUpgrade}` : '';
          const reply = result.content.slice(-3800) + upg;
          await bot.editMessageText(reply, { chat_id: msg.chat.id, message_id: msgId })
            .catch(() => bot.sendMessage(msg.chat.id, reply));
        } else {
          const errText = `❌ ${result.error || '無回應'}\n（latency: ${result.latencyMs}ms）`;
          await safeEdit(msg.chat.id, msgId, errText);
        }
      } catch (err) {
        clearInterval(gammaTimer);
        await safeEdit(msg.chat.id, msgId, `❌ gamma 錯誤：${err.message}`);
      }
      return;
    }

    await safeRunClaude(text, msg.chat.id);
    return;
  }

  if (msg.document) {
    if (!requireAuth(msg.chat.id)) return;
    const file     = msg.document;
    const fileInfo = await bot.getFile(file.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
    const savePath = path.join(workingDir, file.file_name);

    await downloadFile(fileUrl, savePath);
    await bot.sendMessage(msg.chat.id, `📁 已儲存：\`${savePath}\``, { parse_mode: 'Markdown' });

    const caption = (msg.caption || '').trim();
    const prompt  = caption
      ? `${caption}\n\n檔案已儲存至：${savePath}`
      : `請處理這個檔案：${savePath}`;

    await runClaude(prompt, msg.chat.id);
    return;
  }

  if (msg.photo) {
    if (!requireAuth(msg.chat.id)) return;
    // 取最高解析度（陣列最後一個）
    const photo    = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
    const ext      = path.extname(fileInfo.file_path) || '.jpg';
    const savePath = path.join(TG_MEDIA_DIR, `tg_photo_${photo.file_id}${ext}`);

    await downloadFile(fileUrl, savePath);
    await bot.sendMessage(msg.chat.id, `🖼 已儲存：\`${savePath}\``, { parse_mode: 'Markdown' });

    const caption = (msg.caption || '').trim();
    const prompt  = caption || '請描述這張圖片的內容。';

    await safeRunClaude(prompt, msg.chat.id, false, [savePath]);
    return;
  }

});

// ── TG Media cleanup ─────────────────────────────────────────────────────────
// 每小時掃描 _tg_media，刪除超過 MEDIA_TTL_MS 的檔案
(function startMediaCleaner() {
  fs.mkdirSync(TG_MEDIA_DIR, { recursive: true });
  const clean = () => {
    let files;
    try { files = fs.readdirSync(TG_MEDIA_DIR); } catch { return; }
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TG_MEDIA_DIR, f);
      try {
        const { mtimeMs } = fs.statSync(fp);
        if (now - mtimeMs > MEDIA_TTL_MS) fs.unlinkSync(fp);
      } catch {}
    }
  };
  clean(); // 啟動時先清一次
  setInterval(clean, 60 * 60 * 1000); // 之後每小時一次
})();

// ── WebFetch confirmation watcher ────────────────────────────────────────────
// 每 500ms 掃描 TMP_WEBFETCH 目錄，偵測 hook 寫入的請求檔並送 Telegram 確認
(function startWebFetchWatcher() {
  fs.mkdirSync(TMP_WEBFETCH, { recursive: true });
  setInterval(() => {
    let files;
    try { files = fs.readdirSync(TMP_WEBFETCH); } catch { return; }
    for (const f of files) {
      if (!f.startsWith('req_') || !f.endsWith('.json')) continue;
      const reqPath = path.join(TMP_WEBFETCH, f);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
        fs.unlinkSync(reqPath); // 讀完立刻刪，避免重複傳送
      } catch { continue; }
      const { url, rootDomain, chatId: reqChatId, uuid } = req;
      bot.sendMessage(reqChatId,
        `🌐 *WebFetch 確認*\nClaude 要存取：\n\`${url}\`\n\n允許後，\`${rootDomain || url}\` 的所有網址將自動放行。`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 允許', callback_data: `wf:allow:${uuid}` },
              { text: '❌ 拒絕', callback_data: `wf:deny:${uuid}` },
            ]],
          },
        }
      ).catch(() => {});
    }
  }, 500);
})();

// ── Error handling ────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log(`Bot 啟動，工作目錄：${workingDir}`);
console.log(`允許目錄：${ALLOWED_DIRS.join(', ')}`);

// 啟動時通知 owner（重啟後提示驗證）
bot.sendMessage(ALLOWED_USER_ID, '✅ Bot 已上線！請輸入驗證碼').catch(() => {});
