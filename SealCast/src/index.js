/**
 * SealCast 主入口
 * 用法：
 *   node src/index.js draft    → 從 Claude 歷史生成草稿
 *   node src/index.js publish  → 發布草稿到 Threads + LinkedIn（需 MCP 設定）
 */
import { extractAndDraft } from "./processors/learningExtractor.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = join(__dirname, "../drafts");

const cmd = process.argv[2];

if (cmd === "draft") {
  console.log("🔍 掃描 Claude 對話紀錄...");
  const drafts = extractAndDraft();

  if (drafts.length === 0) {
    console.log("⚠️  沒有找到符合學習關鍵字的對話。");
  } else {
    console.log(`✅ 生成 ${drafts.length} 組草稿：`);
    for (const d of drafts) {
      console.log(`\n── ${d.project} ──`);
      console.log("[Threads 預覽]");
      console.log(d.threads.slice(0, 200) + "...");
    }
    console.log(`\n📁 完整草稿已儲存到 drafts/`);
  }
} else if (cmd === "publish") {
  // 列出草稿供選擇（未來可接互動 CLI）
  if (!existsSync(DRAFTS_DIR)) {
    console.log("❌ drafts/ 目錄不存在，請先執行 node src/index.js draft");
    process.exit(1);
  }

  const files = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".txt"));
  if (files.length === 0) {
    console.log("❌ 沒有草稿，請先執行 node src/index.js draft");
    process.exit(1);
  }

  console.log(`📋 找到 ${files.length} 個草稿：`);
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log("\n💡 發布功能需透過 Claude + MCP 執行，請用 Claude Code 操作 create_thread_post / create_linkedin_post 工具。");
} else {
  console.log(`SealCast v0.1.0

指令：
  node src/index.js draft    → 掃描 Claude 歷史，生成 Threads/LinkedIn 草稿
  node src/index.js publish  → 列出草稿（發布透過 Claude MCP 工具）

MCP 啟動：
  npm run mcp:threads        → 啟動 Threads MCP Server
  npm run mcp:linkedin       → 啟動 LinkedIn MCP Server`);
}
