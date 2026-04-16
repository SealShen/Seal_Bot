/**
 * 從 Claude 對話紀錄收集學習內容
 * 來源：~/.claude/projects/{slug}/{conversation}.jsonl
 *
 * 格式說明：
 *   type=user    → message.content (string)
 *   type=assistant → message.content[].text
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_DIR = join(homedir(), ".claude");

/**
 * 列出所有專案 slug
 */
export function listProjects() {
  const projectsDir = join(CLAUDE_DIR, "projects");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir);
}

/**
 * 讀取單一對話檔案，回傳 user/assistant 訊息陣列
 */
function readConversationFile(filePath) {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const messages = [];

  for (const entry of lines) {
    if (entry.type === "user" && entry.message?.role === "user") {
      const content = entry.message.content;
      let text = "";

      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // 只取 type=text 的部分，跳過 tool_result / tool_use
        text = content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }

      text = text.trim();
      // 跳過純 IDE/系統 metadata 訊息
      if (
        text.length > 0 &&
        !text.startsWith("<ide_selection>") &&
        !text.startsWith("<ide_opened_file>") &&
        !text.startsWith("<local-command-stdout>")
      ) {
        messages.push({ role: "user", text, timestamp: entry.timestamp });
      }
    } else if (entry.type === "assistant" && entry.message?.role === "assistant") {
      const parts = entry.message.content;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (text.length > 0) {
          messages.push({ role: "assistant", text, timestamp: entry.timestamp });
        }
      }
    }
  }

  return messages;
}

/**
 * 讀取特定專案的所有對話
 */
export function readProjectConversations(projectSlug) {
  const projectDir = join(CLAUDE_DIR, "projects", projectSlug);
  if (!existsSync(projectDir)) return [];

  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  const conversations = [];

  for (const file of files) {
    const messages = readConversationFile(join(projectDir, file));
    if (messages.length > 1) {
      conversations.push({
        id: file.replace(".jsonl", ""),
        projectSlug,
        messages,
      });
    }
  }

  return conversations;
}

/**
 * 收集所有專案的對話，回傳結構化資料
 */
export function collectAll() {
  const projects = listProjects();
  const result = { projects: [], totalConversations: 0 };

  for (const slug of projects) {
    const conversations = readProjectConversations(slug);
    if (conversations.length > 0) {
      result.projects.push({ slug, conversations });
      result.totalConversations += conversations.length;
    }
  }

  return result;
}

// CLI 直接執行時顯示摘要
if (process.argv[1].includes("claudeHistory")) {
  const data = collectAll();
  console.log(`找到 ${data.projects.length} 個專案，共 ${data.totalConversations} 個對話`);
  for (const p of data.projects) {
    console.log(`  - ${p.slug}: ${p.conversations.length} 個對話`);
    const sample = p.conversations[0]?.messages[0];
    if (sample) console.log(`    樣本: ${sample.text.slice(0, 80)}`);
  }
}
