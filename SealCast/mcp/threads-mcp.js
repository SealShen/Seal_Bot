#!/usr/bin/env node
/**
 * Threads MCP Server
 *
 * 兩步驟發文流程（強制人工審閱）：
 *   1. stage_thread_post(text)      → 存草稿，回傳預覽 + draft_id
 *   2. publish_thread_draft(draft_id) → 人工確認後才真正發文
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
const PENDING_FILE = join(DRAFTS_DIR, "pending-threads.json");

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

// --- Threads API ---

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

async function createMediaContainer(userId, token, text) {
  const res = await fetch(`${THREADS_API_BASE}/${userId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: "TEXT", text, access_token: token }),
  });
  if (!res.ok) throw new Error(`建立 container 失敗: ${await res.text()}`);
  return (await res.json()).id;
}

async function publishThread(userId, token, creationId) {
  const res = await fetch(`${THREADS_API_BASE}/${userId}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  if (!res.ok) throw new Error(`發布失敗: ${await res.text()}`);
  return await res.json();
}

// --- MCP Server ---

const server = new McpServer({ name: "sealcast-threads", version: "0.2.0" });

server.tool(
  "stage_thread_post",
  "【步驟一】將貼文存入待審佇列，回傳預覽與 draft_id。必須由使用者確認後才能發布。",
  {
    text: z.string().max(500).describe("貼文內容（上限 500 字）"),
  },
  async ({ text }) => {
    const draftId = `th-${randomUUID().slice(0, 8)}`;
    const pending = loadPending();

    pending[draftId] = {
      text,
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
            `字數：${text.length} / 500`,
            ``,
            `──── 預覽 ────`,
            text,
            `──────────────`,
            ``,
            `確認無誤後，請呼叫 publish_thread_draft("${draftId}") 發布。`,
            `取消請呼叫 discard_thread_draft("${draftId}")。`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "publish_thread_draft",
  "【步驟二】發布已審閱的草稿。必須先執行 stage_thread_post 取得 draft_id。",
  {
    draft_id: z.string().describe("由 stage_thread_post 回傳的 draft_id"),
  },
  async ({ draft_id }) => {
    const userId = process.env.THREADS_USER_ID;
    const token = process.env.THREADS_ACCESS_TOKEN;

    if (!userId || !token) {
      return {
        content: [{ type: "text", text: "錯誤：THREADS_USER_ID 或 THREADS_ACCESS_TOKEN 未設定" }],
      };
    }

    const pending = loadPending();
    const draft = pending[draft_id];

    if (!draft) {
      return {
        content: [{ type: "text", text: `找不到草稿 ${draft_id}，請先執行 stage_thread_post。` }],
      };
    }

    if (draft.status !== "pending") {
      return {
        content: [{ type: "text", text: `草稿 ${draft_id} 狀態為 ${draft.status}，無法重複發布。` }],
      };
    }

    const creationId = await createMediaContainer(userId, token, draft.text);
    const result = await publishThread(userId, token, creationId);

    draft.status = "published";
    draft.publishedAt = new Date().toISOString();
    draft.postId = result.id;
    savePending(pending);

    return {
      content: [
        {
          type: "text",
          text: `✅ 成功發文到 Threads！\nPost ID: ${result.id}\nDraft ID: ${draft_id}`,
        },
      ],
    };
  }
);

server.tool(
  "discard_thread_draft",
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
  "list_thread_drafts",
  "列出所有待審中的 Threads 草稿",
  {},
  async () => {
    const pending = loadPending();
    const entries = Object.entries(pending);

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "目前沒有待審草稿。" }] };
    }

    const lines = entries.map(([id, d]) =>
      `[${d.status}] ${id} (${d.createdAt.slice(0, 16)})\n  ${d.text.slice(0, 60)}...`
    );

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "get_threads_profile",
  "取得目前授權帳號的 Threads 基本資料",
  {},
  async () => {
    const userId = process.env.THREADS_USER_ID;
    const token = process.env.THREADS_ACCESS_TOKEN;
    if (!userId || !token) {
      return { content: [{ type: "text", text: "錯誤：憑證未設定" }] };
    }
    const url = `${THREADS_API_BASE}/${userId}?fields=id,username,name&access_token=${token}`;
    const res = await fetch(url);
    return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
