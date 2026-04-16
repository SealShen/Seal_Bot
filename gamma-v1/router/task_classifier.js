'use strict';
/**
 * task_classifier.js
 * Rule-based profile classification. No ML needed for v1.
 *
 * Profiles: explorer | implementer | architect | security
 *
 * Explicit override: include [profile:xxx] anywhere in prompt.
 */

const RULES = {
  // security — highest priority: audit/vuln keywords
  security: [
    /\baudit\b|security|vuln(?:erab)|cve\b|xss\b|sql.?inject|csrf|privesc|exploit|pentest|sanitize|injection/i,
    /安全|漏洞|資安|稽核|滲透|注入|弱點/,
  ],
  // implementer — write/change/fix keywords
  implementer: [
    /\b(?:implement|create|build|add|fix|refactor|update|modify|change|write|delete|remove|deploy|install|patch|migrate|rename|replace)\b/i,
    /實作|建立|新增|修改|修正|刪除|部署|安裝|重構|改寫|遷移|修復/,
  ],
  // architect — design/plan/evaluate keywords
  architect: [
    /\b(?:design|plan|architect|strategy|proposal|compare|evaluate|trade.?off|propose|recommend|consider|alternative)\b/i,
    /設計|規劃|架構|方案|評估|比較|建議|替代|考慮/,
  ],
  // explorer — default: read/find/explain
  explorer: [
    /\b(?:what|how|why|explain|list|show|find|search|read|check|look|describe|summarize|overview|inspect|analyse|analyze|tell me|walk me)\b/i,
    /[?？]/,  // ASCII + 全形問號
    /查看|說明|找|解釋|列出|搜尋|摘要|了解|探索|閱讀|確認|什麼|為什麼|如何|怎麼/,
  ],
};

// Priority for tie-breaking (first = highest)
const PRIORITY = ['security', 'implementer', 'architect', 'explorer'];

/**
 * Classify a prompt into a profile.
 * @param {string} prompt
 * @returns {{ profile: string, auto: boolean, scores: object }}
 */
function classify(prompt) {
  // 1. Explicit override
  const override = prompt.match(/\[profile:(explorer|implementer|architect|security)\]/i);
  if (override) {
    const profile = override[1].toLowerCase();
    return { profile, auto: false, scores: {} };
  }

  // 2. Score each profile
  const scores = {};
  for (const [name, patterns] of Object.entries(RULES)) {
    scores[name] = patterns.filter(p => p.test(prompt)).length;
  }

  // 3. Pick highest, tie-break by PRIORITY; fallback 'explorer' if all scores are 0
  const maxScore = Math.max(...Object.values(scores));
  const profile  = maxScore === 0
    ? 'explorer'
    : (PRIORITY.find(p => scores[p] === maxScore) || 'explorer');

  return { profile, auto: true, scores };
}

module.exports = { classify };
