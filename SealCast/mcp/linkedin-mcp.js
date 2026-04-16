#!/usr/bin/env node
/**
 * LinkedIn MCP Server
 *
 * 兩步驟發文流程（強制人工審閱）：
 *   1. stage_linkedin_post(text, visibility) → 存草稿，回傳預覽 + draft_id
 *   2. publish_linkedin_draft(draft_id)       → 人工確認後才真正發文
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = join(__dirname, "../drafts");
const PENDING_FILE = join(DRAFTS_DIR, "pending-linkedin.json");

function loadEnv() {
  try {
    const lines = readFileSync(join(__dirname, "../.env"), "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (match) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}
loadEnv();

// --- 草稿佇列 ---

function loadPending() {
  if (!existsSync(PENDING_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePending(data) {
  if (!existsSync(DRAFTS_DIR)) mkdirSync(DRAFTS_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), "utf8");
}

// --- LinkedIn API ---

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";

async function createPost(personUrn, token, text, visibility) {
  const res = await fetch(`${LINKEDIN_API_BASE}/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn 發文失敗: ${await res.text()}`);
  return await res.json();
}

// --- MCP Server ---

const server = new McpServer({ name: "sealcast-linkedin", version: "0.2.0" });

server.tool(
  "stage_linkedin_post",
  "【步驟一】將貼文存入待審佇列，回傳預覽與 draft_id。必須由使用者確認後才能發布。",
  {
    text: z.string().max(3000).describe("貼文內容（上限 3000 字）"),
    visibility: z
      .enum(["PUBLIC", "CONNECTIONS"])
      .optional()
      .default("PUBLIC")
      .describe("PUBLIC = 公開，CONNECTIONS = 只限連結人"),
  },
  async ({ text, visibility }) => {
    const draftId = `li-${randomUUID().slice(0, 8)}`;
    const pending = loadPending();

    pending[draftId] = {
      text,
      visibility,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    savePending(pending);

    return {
      content: [
        {
          type: "text",
          text: [
            `📋 草稿已儲存，等待你的確認`,
            ``,
            `Draft ID：${draftId}`,
            `字數：${text.length} / 3000`,
            `公開設定：${visibility}`,
            ``,
            `──── 預覽 ────`,
            text,
            `──────────────`,
            ``,
            `確認無誤後，請呼叫 publish_linkedin_draft("${draftId}") 發布。`,
            `取消請呼叫 discard_linkedin_draft("${draftId}")。`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "publish_linkedin_draft",
  "【步驟二】發布已審閱的草稿。必須先執行 stage_linkedin_post 取得 draft_id。",
  {
    draft_id: z.string().describe("由 stage_linkedin_post 回傳的 draft_id"),
  },
  async ({ draft_id }) => {
    const personUrn = process.env.LINKEDIN_PERSON_URN;
    const token = process.env.LINKEDIN_ACCESS_TOKEN;

    if (!personUrn || !token) {
      return {
        content: [{ type: "text", text: "錯誤：LINKEDIN_PERSON_URN 或 LINKEDIN_ACCESS_TOKEN 未設定" }],
      };
    }

    const pending = loadPending();
    const draft = pending[draft_id];

    if (!draft) {
      return {
        content: [{ type: "text", text: `找不到草稿 ${draft_id}，請先執行 stage_linkedin_post。` }],
      };
    }

    if (draft.status !== "pending") {
      return {
        content: [{ type: "text", text: `草稿 ${draft_id} 狀態為 ${draft.status}，無法重複發布。` }],
      };
    }

    const result = await createPost(personUrn, token, draft.text, draft.visibility);
    const postId = result.id || result["x-restli-id"] || "unknown";

    draft.status = "published";
    draft.publishedAt = new Date().toISOString();
    draft.postId = postId;
    savePending(pending);

    return {
      content: [
        {
          type: "text",
          text: `✅ 成功發文到 LinkedIn！\nPost URN: ${postId}\nDraft ID: ${draft_id}`,
        },
      ],
    };
  }
);

server.tool(
  "discard_linkedin_draft",
  "取消並刪除待審草稿",
  {
    draft_id: z.string().describe("要取消的 draft_id"),
  },
  async ({ draft_id }) => {
    const pending = loadPending();
    if (!pending[draft_id]) {
      return { content: [{ type: "text", text: `找不到草稿 ${draft_id}` }] };
    }
    delete pending[draft_id];
    savePending(pending);
    return { content: [{ type: "text", text: `草稿 ${draft_id} 已取消刪除。` }] };
  }
);

server.tool(
  "list_linkedin_drafts",
  "列出所有待審中的 LinkedIn 草稿",
  {},
  async () => {
    const pending = loadPending();
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "目前沒有待審草稿。" }] };
    }
    const lines = entries.map(([id, d]) =>
      `[${d.status}] ${id} (${d.createdAt.slice(0, 16)}) ${d.visibility}\n  ${d.text.slice(0, 60)}...`
    );
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "get_linkedin_profile",
  "取得目前授權帳號的 LinkedIn 基本資料",
  {},
  async () => {
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!token) {
      return { content: [{ type: "text", text: "錯誤：LINKEDIN_ACCESS_TOKEN 未設定" }] };
    }
    const res = await fetch(`${LINKEDIN_API_BASE}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
