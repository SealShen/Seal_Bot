'use strict';
/**
 * policy.js
 * Guardrails: denylist patterns, path-escape check, confirmation gate.
 * Deliberately mirrors the security rules in bot.js so they stay in sync.
 */

// Hard-block patterns — these are always denied
const BLOCK_RULES = [
  { pattern: /\.(env|pem|key|p12|pfx)\b|id_rsa/i,                             reason: '禁止存取憑證／金鑰檔案' },
  { pattern: /printenv|Get-ChildItem\s+env:|echo\s+%\w*(key|token|secret)\w*%/i, reason: '禁止列印環境變數' },
  { pattern: /process\.env\.\w*(key|token|secret|password|api)\w*/i,           reason: '禁止讀取憑證環境變數' },
  { pattern: /windows[\\/]system32|syswow64/i,                                 reason: '禁止存取 Windows 系統目錄' },
  { pattern: /format\s+[a-z]:/i,                                               reason: '禁止格式化磁碟' },
  { pattern: /netsh\s|reg\s+(add|delete)|sc\s+create/i,                        reason: '禁止修改系統設定' },
  { pattern: /rm\s+-rf\s+[/\\]|del\s+\/[sf]+\s+[a-z]:\\/i,                    reason: '禁止刪除根目錄' },
];

// Confirm-required patterns — safe to proceed after user says yes
const CONFIRM_RULES = [
  { pattern: /\brm\s+-rf\b|rimraf|rmdir\s+\/s\b|del\s+\/[sf]/i,               reason: '⚠️ 刪除檔案或目錄（不可回復）' },
  { pattern: /git\s+push\s+(.*\s)?-f\b|git\s+push\s+.*--force/i,              reason: '⚠️ Force push 到遠端' },
  { pattern: /drop\s+table|drop\s+database|truncate\s+table/i,                 reason: '⚠️ 刪除資料庫資料' },
  { pattern: /git\s+reset\s+--hard/i,                                          reason: '⚠️ Git hard reset（丟失未提交變更）' },
  { pattern: /npm\s+publish|yarn\s+publish/i,                                  reason: '⚠️ 發布套件到公開 registry' },
];

// Write keywords that are blocked in read-only mode
const WRITE_PATTERN = /\b(create|write|delete|modify|update|insert|drop|truncate|mkdir|rm\b|del\b|append|overwrite)\b/i;

// Dangerous path prefixes — always blocked regardless of other rules (Windows absolute paths)
const DANGEROUS_PATH_PREFIXES = [
  'c:\\windows\\',
  'c:\\program files\\',
  'c:\\program files (x86)\\',
];

// Dangerous path patterns (regex) — catches user-specific sensitive dirs
const DANGEROUS_PATH_PATTERNS = [
  /[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.ssh/i,
  /[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.aws/i,
  /[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.gnupg/i,
  /[a-z]:[/\\]users[/\\][^/\\]+[/\\]appdata[/\\]roaming[/\\]microsoft[/\\]/i,
];

/**
 * Check a prompt against policy rules.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly=false]
 * @param {string}  [opts.workDir]
 * @returns {{ action: 'allow'|'block'|'confirm', reason?: string }}
 */
function check(prompt, { readOnly = false, workDir = null } = {}) {
  // 1. Hard blocks
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(prompt)) {
      return { action: 'block', reason: rule.reason };
    }
  }

  // 2. Read-only mode: block write keywords
  if (readOnly && WRITE_PATTERN.test(prompt)) {
    return { action: 'block', reason: 'Read-only profile: 禁止寫入操作' };
  }

  // 3. Dangerous-path check (denylist)
  const absPaths = prompt.match(/[a-zA-Z]:[/\\][^\s,'"`)]+/g) || [];
  for (const p of absPaths) {
    const norm = p.replace(/\//g, '\\').toLowerCase();
    if (DANGEROUS_PATH_PREFIXES.some(d => norm.startsWith(d))) {
      return { action: 'block', reason: `禁止存取危險系統路徑：${p}` };
    }
    if (DANGEROUS_PATH_PATTERNS.some(re => re.test(p))) {
      return { action: 'block', reason: `禁止存取敏感使用者路徑：${p}` };
    }
  }

  // 4. Confirm gate
  for (const rule of CONFIRM_RULES) {
    if (rule.pattern.test(prompt)) {
      return { action: 'confirm', reason: rule.reason };
    }
  }

  return { action: 'allow' };
}

module.exports = { check };
