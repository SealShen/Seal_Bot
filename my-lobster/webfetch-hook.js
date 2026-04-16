#!/usr/bin/env node
/**
 * webfetch-hook.js
 * Claude Code PreToolUse hook — 攔截 WebFetch，透過 Telegram Bot 詢問確認
 * 一旦使用者核准某個根網域，後續同網域的請求自動放行。
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TMP_DIR        = path.join(os.tmpdir(), 'claude_webfetch');
const WHITELIST_FILE = path.join(__dirname, 'webfetch-whitelist.json');
const TIMEOUT        = 60_000;
const POLL_MS        = 500;

// ── 白名單 helpers ────────────────────────────────────────────────────────────

function loadWhitelist() {
  try { return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')); } catch { return []; }
}

function saveToWhitelist(domain) {
  const list = loadWhitelist();
  if (!list.includes(domain)) {
    list.push(domain);
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2), 'utf8');
  }
}

/**
 * 從 hostname 取得根網域（最後兩段，例：api.github.com → github.com）
 * 白名單比對時，hostname 等於或以 .rootDomain 結尾都算符合。
 */
function getRootDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function isDomainWhitelisted(hostname) {
  const root = getRootDomain(hostname);
  return loadWhitelist().some(d => hostname === d || hostname.endsWith('.' + d));
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch {}

  // 非 Bot session → 直接放行
  if (process.env.CLAUDE_FROM_BOT !== '1') process.exit(0);

  const url    = data.tool_input?.url || '';
  const chatId = process.env.CLAUDE_BOT_CHATID;
  if (!chatId) process.exit(0);

  // 解析 URL
  let hostname = '(unknown)';
  let protocol = '';
  try { const u = new URL(url); hostname = u.hostname; protocol = u.protocol; } catch {}

  // HTTPS 網域 → 直接放行
  if (protocol === 'https:') process.exit(0);

  // 已在白名單 → 直接放行（HTTP 等非 HTTPS 仍走確認流程）
  if (isDomainWhitelisted(hostname)) process.exit(0);

  const rootDomain = getRootDomain(hostname);

  // 產生唯一 ID（不含特殊字元）
  const uuid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const reqFile = path.join(TMP_DIR, `req_${uuid}.json`);
  const resFile = path.join(TMP_DIR, `res_${uuid}.json`);

  // 把根網域一起帶給 bot.js，讓確認訊息顯示清楚
  fs.writeFileSync(reqFile, JSON.stringify({ url, hostname, rootDomain, chatId, uuid }), 'utf8');

  // Poll 等待回應
  const start = Date.now();
  const timer = setInterval(() => {

    if (fs.existsSync(resFile)) {
      clearInterval(timer);
      let allow = false;
      try {
        const res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        allow = !!res.allow;
        fs.unlinkSync(resFile);
      } catch {}
      try { fs.unlinkSync(reqFile); } catch {}

      if (allow) {
        saveToWhitelist(rootDomain); // 核准後加入白名單
        process.exit(0);
      } else {
        deny('使用者從 Bot 拒絕此網址存取');
      }
      return;
    }

    if (Date.now() - start > TIMEOUT) {
      clearInterval(timer);
      try { fs.unlinkSync(reqFile); } catch {}
      deny('等待 Bot 確認逾時（60 秒）');
    }

  }, POLL_MS);
});

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
