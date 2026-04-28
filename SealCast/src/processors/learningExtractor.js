/**
 * 從對話訊息中提取學習重點，輸出草稿
 * 目前使用規則式提取，後續可接 Claude API（透過 MCP）
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { collectAll } from "../collectors/claudeHistory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = join(__dirname, "../../drafts");

// 關鍵字：出現這些詞的訊息可能包含學習重點
const LEARNING_KEYWORDS = [
  "學到", "原來", "發現", "理解", "搞清楚", "終於", "原理",
  "為什麼", "怎麼做", "如何", "解決", "問題", "錯誤", "fix",
  "learn", "understand", "realize", "found out", "turns out",
];

/**
 * 判斷一段文字是否可能是學習紀錄
 */
function isLearningMoment(text) {
  const lower = text.toLowerCase();
  return LEARNING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 將學習訊息格式化成 Threads 風格貼文草稿
 */
function formatThreadsDraft(messages, projectSlug, date) {
  const snippets = messages.slice(0, 3).map((m) => `• ${m.text.slice(0, 100)}`);
  return [
    `📚 學習紀錄 ${date}`,
    ``,
    `在 ${projectSlug} 專案中，我和 Claude 協作，記錄幾個關鍵學習點：`,
    ``,
    ...snippets,
    ``,
    `#學習紀錄 #ClaudeAI #SealCast`,
  ].join("\n");
}

/**
 * 將學習訊息格式化成 LinkedIn 風格貼文草稿
 */
function formatLinkedInDraft(messages, projectSlug, date) {
  const snippets = messages.slice(0, 5).map((m) => `▸ ${m.text.slice(0, 150)}`);
  return [
    `🚀 今天的學習紀錄 | ${date}`,
    ``,
    `最近在 ${projectSlug.replace(/^c--Users-[^-]+-/, "").replace(/-/g, " ")} 專案與 AI 協作，整理幾個重要的學習收穫：`,
    ``,
    ...snippets,
    ``,
    `持續學習，持續成長。`,
    ``,
    `#AI協作 #持續學習 #SealCast #Claude`,
  ].join("\n");
}

/**
 * 主流程：提取學習點，生成草稿
 */
export function extractAndDraft() {
  if (!existsSync(DRAFTS_DIR)) {
    mkdirSync(DRAFTS_DIR, { recursive: true });
  }

  const data = collectAll();
  const today = new Date().toISOString().slice(0, 10);
  const drafts = [];

  for (const project of data.projects) {
    for (const conv of project.conversations) {
      const messages = conv.messages.filter((m) => m.text && m.text.trim().length > 20);
      const learnings = messages.filter((m) => isLearningMoment(m.text));

      if (learnings.length === 0) continue;

      const threadsDraft = formatThreadsDraft(learnings, project.slug, today);
      const linkedinDraft = formatLinkedInDraft(learnings, project.slug, today);

      const base = `${today}_${project.slug.slice(0, 30)}_${conv.id}`;

      writeFileSync(join(DRAFTS_DIR, `${base}_threads.txt`), threadsDraft, "utf8");
      writeFileSync(join(DRAFTS_DIR, `${base}_linkedin.txt`), linkedinDraft, "utf8");

      drafts.push({ project: project.slug, threads: threadsDraft, linkedin: linkedinDraft });
    }
  }

  return drafts;
}

// CLI 執行
if (process.argv[1].includes("learningExtractor")) {
  const drafts = extractAndDraft();
  console.log(`生成了 ${drafts.length} 組草稿，已儲存到 drafts/`);
}
