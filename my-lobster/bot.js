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
const telegramifyMarkdown = require('telegramify-markdown');

// telegramify-markdown 不 escape V2 保留字中無 markdown 語意的字元（. ! + = { }）
// 此函式在 code block 外補 escape，code block 內不動（V2 規定 code 內只需 escape \ 和 `）
function postEscapeV2(text) {
  return text
    .replace(/(```[\s\S]*?```|`[^`\n]+`)|\\\\([.!+={}])/g, (m, code, ch) => {
      if (code) return code;
      if (ch) return '\\' + ch;
      return m;
    })
    .replace(/(```[\s\S]*?```|`[^`\n]+`)|(?<!\\)([.!+={}])/g, (m, code, ch) => {
      if (code) return code;
      if (ch) return '\\' + ch;
      return m;
    });
}

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

// DIR_LABELS 對應 _extraDirs（額外目錄）的顯示標籤，DEFAULT_DIR 固定取 basename
// .env 範例：ALLOWED_DIRS=C:\proj1;C:\proj2   DIR_LABELS=Proj1;Proj2
const _dirLabels = (process.env.DIR_LABELS || '').split(';').map(s => s.trim());
// 選單按鈕（排除 _tg_media）：{ label, dir }
const DIR_BUTTONS = ALLOWED_DIRS
  .filter(d => d !== TG_MEDIA_DIR)
  .map((d) => {
    const extraIdx = _extraDirs.indexOf(d);
    const name = extraIdx >= 0
      ? (_dirLabels[extraIdx] || path.basename(d))  // extra dir → 對應 DIR_LABELS
      : path.basename(d);                             // DEFAULT_DIR → 直接取 basename
    return { label: '📂 ' + name, dir: d };
  });

const STREAM_INTERVAL = 3000;
const MAX_LEN         = 3800;
const MEDIA_TTL_MS    = 24 * 60 * 60 * 1000; // _tg_media 檔案保留 24 小時
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
let autoMode        = false; // --dangerously-skip-permissions toggle
let claudeModel     = null;  // null = 預設, 'haiku'|'sonnet'|'opus' = --model 指定
let pendingGemmaContext = null; // 從 gemma 切回 Claude 時，保存 gemma 最後一句回覆，下次送 Claude 時前置一次

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

  // 'result' 事件的 ev.result 是最後 assistant 文字的副本，忽略以避免重複輸出
  if (t === 'result') return null;

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
  // stream-json --verbose 會對同一個 assistant message 發多次事件（partial + final，內容都是完整文字）
  // 用 msg.id 去重：同 id 後到者覆蓋原本那段，不累加
  const blocks = []; // { id: string|null, text: string }
  const rebuildOutput = () => { output = blocks.map(b => b.text).filter(Boolean).join('\n') + (blocks.length ? '\n' : ''); };
  const appendBlock = (id, text) => {
    if (id) {
      const existing = blocks.find(b => b.id === id);
      if (existing) { existing.text = text; rebuildOutput(); return; }
    }
    blocks.push({ id: id || null, text });
    output += text + '\n';
  };

  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (autoMode) args.push('--dangerously-skip-permissions');
  if (claudeModel) args.push('--model', claudeModel);
  if (!useNewSession) {
    if (currentSessionId) args.push('--resume', currentSessionId);
    else args.push('--continue');
  }

  const env = { ...process.env, CLAUDE_FROM_BOT: '1', CLAUDE_BOT_CHATID: String(chatId) };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY; // 訂閱用戶走 OAuth，無效的 API key 會導致 "Invalid API key" 錯誤

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
  // 若剛從 gemma 切回，前置 gemma 最後一句輸出（一次性，用完清空）
  const gemmaCtx = pendingGemmaContext;
  pendingGemmaContext = null;
  const gemmaSection = gemmaCtx
    ? `[以下是使用者剛才在 Gemma（本機小模型）那邊得到的最後一段輸出，僅供參考脈絡，請根據使用者接下來的訊息回應]\n${gemmaCtx}\n\n---\n\n`
    : '';
  proc.stdin.write(langPrefix + gemmaSection + prompt + imageSection, 'utf8');
  proc.stdin.end();

  currentProc = proc;

  proc.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop(); // 保留尚未結束的最後一行
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch {}
      if (ev?.session_id) capturedSession = ev.session_id;
      const display = parseStreamLine(line);
      if (!display) continue;
      const id = ev?.type === 'assistant' ? ev.message?.id : null;
      appendBlock(id, display);
    }
  });

  proc.stderr.on('data', (d) => { appendBlock(null, d.toString()); });

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
      let ev = null;
      try { ev = JSON.parse(lineBuf); } catch {}
      if (ev?.session_id) capturedSession = ev.session_id;
      const display = parseStreamLine(lineBuf);
      if (display) {
        const id = ev?.type === 'assistant' ? ev.message?.id : null;
        appendBlock(id, display);
      }
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

    const icon = code === 0 ? '✅' : '❌';
    const footerV1 = code !== 0 ? `  _(exit ${code})_` : '';
    const bodyText = tail(output) || '(no output)';

    let renderedOk = false;
    try {
      const headerV2 = code === 0
        ? '✅ *完成*\n\n'
        : `❌ *完成*  _\\(exit ${code}\\)_\n\n`;
      const rendered = headerV2 + postEscapeV2(telegramifyMarkdown(bodyText, 'escape'));
      console.log('[TG_RENDER_DEBUG] rendered:\n' + rendered);
      await bot.editMessageText(rendered, { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2' });
      renderedOk = true;
    } catch {}

    if (!renderedOk) {
      const fallback = `${icon} 完成${footerV1}\n\`\`\`\n${bodyText}\n\`\`\``;
      try {
        await bot.editMessageText(fallback, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(chatId, fallback).catch(() => {});
      }
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
// 目錄按鈕每列最多兩顆
const _dirRows = [];
for (let i = 0; i < DIR_BUTTONS.length; i += 2) {
  _dirRows.push(DIR_BUTTONS.slice(i, i + 2).map(b => b.label));
}
const MAIN_KEYBOARD = {
  keyboard: [
    ..._dirRows,
    ['📑 Sessions', '🔄 重啟'],
    ['🛑 取消執行', '📋 目前狀態'],
    ['⚠️Auto Mode', '✨Model'],
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
const SESSIONS_PER_PAGE = 8;
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// 目錄路徑 → slug（與 Claude Code session 目錄命名規則相同）
function pathToSlug(p) {
  return p.replace(/^([A-Za-z]):[\/\\]/, '$1--').replace(/[\/\\]/g, '-');
}

// DIR_LABEL：slug → 顯示名稱（與 DIR_BUTTONS 邏輯相同）
const DIR_LABEL = {};
ALLOWED_DIRS.forEach((d) => {
  if (d === TG_MEDIA_DIR) return;
  const extraIdx = _extraDirs.indexOf(d);
  const name = extraIdx >= 0
    ? (_dirLabels[extraIdx] || path.basename(d))
    : path.basename(d);
  DIR_LABEL[pathToSlug(d).toLowerCase()] = name;
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
      if (!(dir.name.toLowerCase() in DIR_LABEL)) continue; // 只顯示 ALLOWED_DIRS 內的專案
      const label = DIR_LABEL[dir.name.toLowerCase()];
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
          // 對齊 VSCode extension：64KB head + 64KB tail（若檔案 < 64KB，tail = head）
          const CHUNK = 65536;
          const fd   = fs.openSync(filePath, 'r');
          const buf  = Buffer.alloc(CHUNK);
          const n    = fs.readSync(fd, buf, 0, CHUNK, 0);
          const head = buf.slice(0, n).toString('utf8');
          let tail   = head;
          const tailStart = Math.max(0, fileSize - CHUNK);
          if (tailStart > 0) {
            const buf2 = Buffer.alloc(CHUNK);
            const n2   = fs.readSync(fd, buf2, 0, CHUNK, tailStart);
            tail = buf2.slice(0, n2).toString('utf8');
          }
          fs.closeSync(fd);
          // 原始字串搜尋，對齊 VSCode：找最後一個 match、接受 "k":"v" 與 "k": "v" 兩種格式、用 JSON.parse 正確 unescape
          const extractField = (chunk, field) => {
            const prefixes = [`"${field}":"`, `"${field}": "`];
            let best = null;
            let bestPos = -1;
            for (const prefix of prefixes) {
              let start = 0;
              while (true) {
                const p = chunk.indexOf(prefix, start);
                if (p < 0) break;
                const valStart = p + prefix.length;
                let i = valStart;
                while (i < chunk.length) {
                  if (chunk[i] === '\\') { i += 2; continue; }
                  if (chunk[i] === '"') break;
                  i++;
                }
                if (p > bestPos) {
                  let raw = chunk.slice(valStart, i);
                  try { raw = JSON.parse(`"${raw}"`); } catch {}
                  best = raw;
                  bestPos = p;
                }
                start = i + 1;
              }
            }
            if (!best) return null;
            const trimmed = String(best).trim();
            return trimmed || null;
          };
          // 優先順序對齊 VSCode extension（tail 優先、lastPrompt/summary 只查 tail）
          firstPrompt = (
            extractField(tail, 'customTitle') ||
            extractField(head, 'customTitle') ||
            extractField(tail, 'aiTitle')     ||
            extractField(head, 'aiTitle')     ||
            extractField(tail, 'lastPrompt')  ||
            extractField(tail, 'summary')
          );
          if (firstPrompt) firstPrompt = firstPrompt.replace(/\s+/g, ' ').slice(0, 50);
        } catch { continue; }
        if (!firstPrompt) continue; // 對齊 VSCode：隱藏無標題的 session
        sessions.push({ id: sessionId, firstPrompt, mtime, project: label });
      }
    }
  } catch {}
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// 抓某個 session 最後一則 assistant 文字回覆（反向掃 jsonl，跳過純 tool_use 事件）
function getLastAssistantText(sessionId) {
  let filePath = null;
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(PROJECTS_ROOT, d.name, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) { filePath = candidate; break; }
    }
  } catch { return null; }
  if (!filePath) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== 'assistant') continue;
      const parts = ev.message?.content;
      let text = '';
      if (Array.isArray(parts)) {
        text = parts.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n').trim();
      } else if (typeof parts === 'string') {
        text = parts.trim();
      }
      if (text) return text;
    }
  } catch {}
  return null;
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

  // ✨Model 選擇
  if (data.startsWith('model:')) {
    const choice = data.slice(6); // 'gemma' | 'haiku' | 'sonnet' | 'opus'
    if (choice === 'gemma') {
      if (!gemmaExecute) {
        bot.editMessageText('❌ gemma-v1 未安裝。', { chat_id: chatId, message_id: msgId });
        return;
      }
      gemmaMode = !gemmaMode;
      claudeModel = null;

      let inheritNote = '';
      if (gemmaMode) {
        // 開啟時：繼承當前 Claude session 歷史（切回 Claude 時不會反向注入）
        const r = inheritClaudeSessionToGemma();
        if (r.ok) inheritNote = `\n\n📥 已繼承 Claude session 歷史（${r.turns} 則訊息）`;
        else { gemmaHistory = []; inheritNote = `\n\n_（無可繼承的歷史：${r.reason}）_`; }
      } else {
        // 關閉時：抓 gemma 最後一句 assistant 回覆，排入下一則 Claude prompt 的前置
        const lastAssistant = [...gemmaHistory].reverse().find(m => m.role === 'assistant');
        if (lastAssistant?.content) {
          pendingGemmaContext = lastAssistant.content;
          inheritNote = '\n\n📎 下一則訊息將自動附帶 Gemma 最後一句輸出給 Claude';
        }
        gemmaHistory = []; // 關閉時清空，不回寫 Claude session
      }

      bot.editMessageText(
        (gemmaMode
          ? '🤖 *Gemma 模式開啟*\n普通訊息直接傳給 Gemma（本機）'
          : '💻 *Gemma 模式關閉*\n普通訊息回到 Claude Code') + inheritNote,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      );
    } else {
      // 從 gemma 切 Claude model 時，抓最後一句 gemma 回覆排入下一則 Claude prompt
      let ctxNote = '';
      if (gemmaMode) {
        const lastAssistant = [...gemmaHistory].reverse().find(m => m.role === 'assistant');
        if (lastAssistant?.content) {
          pendingGemmaContext = lastAssistant.content;
          ctxNote = '\n\n📎 下一則訊息將自動附帶 Gemma 最後一句輸出給 Claude';
        }
      }
      gemmaMode = false;
      gemmaHistory = [];
      const modelMap = { haiku: 'haiku', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6' };
      claudeModel = modelMap[choice] ?? choice;
      const label = choice === 'haiku' ? '⚡ Haiku' : choice === 'sonnet' ? '🎵 Sonnet（預設）' : '🏛 Opus';
      bot.editMessageText(
        `✅ 模型已切換至 *${label}*${ctxNote}`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // Auto Mode 確認
  if (data === 'automode:cancel') {
    bot.editMessageText('❌ 已取消，Auto Mode 維持關閉。', { chat_id: chatId, message_id: msgId });
    return;
  }
  if (data === 'automode:confirm') {
    autoMode = true;
    bot.editMessageText(
      '⚠️ *Auto Mode 已啟用*\n\nClaude 將跳過所有工具確認視窗。\n再按一次 *⚠️Auto Mode* 可隨時關閉。',
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    );
    return;
  }

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
    const currentModel = gemmaMode ? 'gemma' : (claudeModel || 'sonnet');
    await bot.editMessageText(
      `▶ 已切換至 Session：\n${sess?.firstPrompt || id.slice(0, 8) + '…'}\n\n✨ 目前 Model：\`${currentModel}\``,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});

    // 顯示該 session 最後一則 assistant 回覆，幫助使用者確認前文
    const lastReply = getLastAssistantText(id);
    if (lastReply) {
      const TAIL = 3000;
      const preview = lastReply.length > TAIL ? '…' + lastReply.slice(-TAIL) : lastReply;
      await bot.sendMessage(chatId, `💭 最後回覆：\n${preview}`).catch(() => {});
    } else {
      await bot.sendMessage(chatId, '_（此 session 無可預覽的回覆）_', { parse_mode: 'Markdown' }).catch(() => {});
    }
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

// ── gemma integration ────────────────────────────────────────────────────────
// 載入 gemma router（模組目錄名稱 gamma-v1 保留為歷史命名；若不存在則靜默跳過）
let gemmaExecute = null;
try {
  gemmaExecute = require('../gamma-v1/index').execute;
} catch {}

// gemma 模式：開啟後，普通訊息走 gemma 而非 Claude Code
let gemmaMode = false;
// gemma 對話歷史（in-memory，重啟清空）
let gemmaHistory = [];   // [{ role: 'user'|'assistant', content: string }]
const GEMMA_HISTORY_TURNS = 6; // 保留最近 N 輪（user+assistant 各算一）

// 從 Claude session jsonl 讀取歷史，注入到 gemmaHistory（切換到 gemma 時呼叫）
// 繼承後 gemma 會看到 Claude 的對話脈絡，但 gemma 產生的內容不會回寫到 Claude session
function inheritClaudeSessionToGemma() {
  if (!currentSessionId) return { ok: false, reason: '目前沒有進行中的 Claude session' };
  const slug = pathToSlug(workingDir).toLowerCase();
  let actualDir = null;
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT);
    actualDir = dirs.find(d => d.toLowerCase() === slug);
  } catch { return { ok: false, reason: '無法讀取 projects 目錄' }; }
  if (!actualDir) return { ok: false, reason: '找不到對應的專案目錄' };
  const filePath = path.join(PROJECTS_ROOT, actualDir, currentSessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'Session 檔案不存在' };

  const history = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const msgType = ev.type;
      if (msgType !== 'user' && msgType !== 'assistant') continue;
      const parts = ev.message?.content;
      let text = '';
      if (Array.isArray(parts)) {
        text = parts.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n').trim();
      } else if (typeof parts === 'string') {
        text = parts.trim();
      }
      if (!text) continue;
      // 合併連續同角色訊息（Gemma jinja template 要求 user/assistant 嚴格交替）
      const last = history[history.length - 1];
      if (last && last.role === msgType) {
        last.content += '\n\n' + text;
      } else {
        history.push({ role: msgType, content: text });
      }
    }
  } catch (e) { return { ok: false, reason: '讀取失敗：' + e.message }; }

  // Gemma 模板要求：開頭為 user、結尾為 assistant、嚴格 u/a 交替
  while (history.length && history[0].role !== 'user') history.shift();
  while (history.length && history[history.length - 1].role !== 'assistant') history.pop();

  gemmaHistory = history;
  return { ok: true, turns: history.length };
}

// /gmode — 切換 gemma 模式
bot.onText(/\/gmode/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  if (!gemmaExecute) {
    bot.sendMessage(msg.chat.id, '❌ gemma-v1 未安裝。');
    return;
  }
  gemmaMode = !gemmaMode;
  gemmaHistory = []; // 切換時清空歷史
  bot.sendMessage(msg.chat.id,
    gemmaMode
      ? '🤖 *Gemma 模式開啟*\n普通訊息直接傳給 Gemma（本機）\n\n輸入 `/gmode` 可關閉，`/gclear` 清空對話歷史'
      : '💻 *Gemma 模式關閉*\n普通訊息回到 Claude Code',
    { parse_mode: 'Markdown' }
  );
});

// /gclear — 清空 gemma 對話歷史
bot.onText(/\/gclear/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  gemmaHistory = [];
  bot.sendMessage(msg.chat.id, '🧹 Gemma 對話歷史已清空。');
});

// /gemma [flags] <task>
// flags 同 bin/myclaw.js：--profile / --executor / --dir / --yes
bot.onText(/\/gemma(.*)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!requireAuth(msg.chat.id)) return;
  if (!gemmaExecute) {
    bot.sendMessage(msg.chat.id, '❌ gemma-v1 未安裝，請確認 gemma-v1/ 目錄存在。');
    return;
  }

  const raw = (match[1] || '').trim();
  if (!raw) {
    bot.sendMessage(msg.chat.id,
      '*gemma 用法：*\n`/gemma <任務>`\n`/gemma --profile explorer <問題>`\n`/gemma --profile implementer <實作任務>`\n`/gemma --executor local_gemma4 <任務>`',
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

  const statusMsg = await bot.sendMessage(msg.chat.id, '⚙️ Gemma 路由中…');
  const msgId = statusMsg.message_id;
  const gemmaStart = Date.now();
  const gemmaTimer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - gemmaStart) / 1000);
    await safeEdit(msg.chat.id, msgId, `⚙️ Gemma 執行中… ${elapsed}s`);
  }, 5000);

  try {
    const result = await gemmaExecute({ prompt, profile, executor, workDir: useWorkDir, skipConfirm });
    clearInterval(gemmaTimer);

    if (result.blocked) {
      await bot.editMessageText(`🚫 *[BLOCKED]*\n${result.reason}`, { chat_id: msg.chat.id, message_id: msgId, parse_mode: 'Markdown' });
      return;
    }
    if (result.needsConfirm) {
      await bot.editMessageText(
        `⚠️ *確認操作*\n${result.confirmReason}\n\n重新傳送：\`/gemma --yes ${raw}\``,
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
    clearInterval(gemmaTimer);
    await bot.editMessageText(`❌ gemma-v1 錯誤：${err.message}`, { chat_id: msg.chat.id, message_id: msgId })
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

    // 按鈕處理：目錄切換（由 DIR_BUTTONS 動態匹配）
    const dirBtn = DIR_BUTTONS.find(b => b.label === text);
    if (dirBtn) {
      workingDir = dirBtn.dir;
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
      const gemmaSuffix = gemmaMode ? `\n*模式：* 🤖 Gemma（${gemmaHistory.length / 2 | 0} 輪歷史）` : '';
      const autoSuffix = autoMode ? '\n*Auto Mode：* ⚠️ 開啟（跳過工具確認）' : '';
      bot.sendMessage(msg.chat.id,
        `*狀態：* ${status}\n*目錄：* \`${workingDir}\`\n*Session：* ${sessLabel}${gemmaSuffix}${autoSuffix}`,
        { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
      );
      return;
    }
    if (text === '⚠️Auto Mode') {
      if (autoMode) {
        autoMode = false;
        bot.sendMessage(msg.chat.id, '✅ Auto Mode 已關閉，Claude 將在需要時請求確認。', { reply_markup: MAIN_KEYBOARD });
      } else {
        bot.sendMessage(msg.chat.id,
          '⚠️ *確認啟用 Auto Mode？*\n\n啟用後 Claude 將使用 `--dangerously-skip-permissions`，跳過所有工具確認視窗。\n\n請確認你了解風險後再啟用。',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '⚠️ 確認啟用', callback_data: 'automode:confirm' },
                { text: '❌ 取消',     callback_data: 'automode:cancel'  },
              ]],
            },
          }
        );
      }
      return;
    }

    if (text === '✨Model') {
      const current = gemmaMode ? 'gemma' : (claudeModel || 'sonnet');
      bot.sendMessage(msg.chat.id, `✨ *Model 選擇*\n目前：\`${current}\`\n\n選擇要切換的模型：`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `${current === 'gemma'  ? '✅ ' : ''}🤖 Gemma（本機）`,  callback_data: 'model:gemma'  }],
            [{ text: `${current === 'haiku'  ? '✅ ' : ''}⚡ Haiku`,          callback_data: 'model:haiku'  }],
            [{ text: `${current === 'sonnet' ? '✅ ' : ''}🎵 Sonnet（預設）`, callback_data: 'model:sonnet' }],
            [{ text: `${current === 'opus'   ? '✅ ' : ''}🏛 Opus`,           callback_data: 'model:opus'   }],
          ],
        },
      });
      return;
    }

    // gemma 模式：普通訊息走 gemma，帶對話歷史
    if (gemmaMode && gemmaExecute) {
      const statusMsg = await bot.sendMessage(msg.chat.id, '🤖 Gemma 思考中…');
      const msgId = statusMsg.message_id;
      const gemmaStart = Date.now();
      const gemmaTimer = setInterval(async () => {
        const elapsed = Math.floor((Date.now() - gemmaStart) / 1000);
        await safeEdit(msg.chat.id, msgId, `🤖 Gemma 思考中… ${elapsed}s`);
      }, 5000);

      try {
        const result = await gemmaExecute({
          prompt: text,
          history: gemmaHistory.slice(-GEMMA_HISTORY_TURNS),
          workDir: workingDir,
        });
        clearInterval(gemmaTimer);

        if (result.ok && result.content) {
          // 更新對話歷史
          gemmaHistory.push({ role: 'user', content: text });
          gemmaHistory.push({ role: 'assistant', content: result.content });
          // 只保留最近 N 輪
          if (gemmaHistory.length > GEMMA_HISTORY_TURNS * 2) {
            gemmaHistory = gemmaHistory.slice(-GEMMA_HISTORY_TURNS * 2);
          }
          const upg = result.suggestUpgrade ? `\n💡 /gemma --profile ${result.suggestUpgrade}` : '';
          const reply = result.content.slice(-3800) + upg;
          await bot.editMessageText(reply, { chat_id: msg.chat.id, message_id: msgId })
            .catch(() => bot.sendMessage(msg.chat.id, reply));
        } else {
          const errText = `❌ ${result.error || '無回應'}\n（latency: ${result.latencyMs}ms）`;
          await safeEdit(msg.chat.id, msgId, errText);
        }
      } catch (err) {
        clearInterval(gemmaTimer);
        await safeEdit(msg.chat.id, msgId, `❌ Gemma 錯誤：${err.message}`);
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

// 全域未捕獲錯誤：unhandledRejection 不退出，uncaughtException 退出讓 wrapper 重啟
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] [unhandledRejection]`, reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [uncaughtException]`, err);
  setTimeout(() => process.exit(1), 500);
});

console.log(`[${new Date().toISOString()}] Bot 啟動，工作目錄：${workingDir}`);
console.log(`允許目錄：${ALLOWED_DIRS.join(', ')}`);

// 啟動時通知 owner（重啟後提示驗證）
bot.sendMessage(ALLOWED_USER_ID, '✅ Bot 已上線！請輸入驗證碼').catch(() => {});
