#!/usr/bin/env node
/**
 * Twitter/X MCP Server
 *
 * 兩步驟發文流程（強制人工審閱）：
 *   1. stage_tweet(text)      → 存草稿，回傳預覽 + draft_id
 *   2. publish_tweet_draft(draft_id) → 人工確認後才真正發文
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { TwitterApi } from "twitter-api-v2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = join(__dirname, "../drafts");
const PENDING_FILE = join(DRAFTS_DIR, "pending-twitter.json");

// --- 環境變數 ---

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

function getClient() {
  const { TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET } =
    process.env;

  if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET) {
    return null;
  }

  return new TwitterApi({
    appKey: TWITTER_API_KEY,
    appSecret: TWITTER_API_SECRET,
    accessToken: TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_SECRET,
  });
}

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

// --- MCP Server ---

const server = new McpServer({ name: "sealcast-twitter", version: "0.1.0" });

server.tool(
  "stage_tweet",
  "【步驟一】將推文存入待審佇列，回傳預覽與 draft_id。必須由使用者確認後才能發布。",
  {
    text: z.string().max(280).describe("推文內容（上限 280 字）"),
  },
  async ({ text }) => {
    const charCount = [...text].length; // 正確計算 Unicode 字數
    if (charCount > 280) {
      return {
        content: [{ type: "text", text: `超過 280 字限制（目前 ${charCount} 字）` }],
      };
    }

    const draftId = `tw-${randomUUID().slice(0, 8)}`;
    const pending = loadPending();

    pending[draftId] = {
      text,
      charCount,
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
            `字數：${charCount} / 280`,
            ``,
            `──── 預覽 ────`,
            text,
            `──────────────`,
            ``,
            `✅ 確認發布：publish_tweet_draft("${draftId}")`,
            `❌ 取消草稿：discard_tweet_draft("${draftId}")`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "publish_tweet_draft",
  "【步驟二】發布已審閱的推文草稿。必須先執行 stage_tweet 取得 draft_id。",
  {
    draft_id: z.string().describe("由 stage_tweet 回傳的 draft_id（格式：tw-xxxxxxxx）"),
  },
  async ({ draft_id }) => {
    const client = getClient();
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: "錯誤：Twitter 憑證未設定，請在 .env 填入 TWITTER_API_KEY / TWITTER_API_SECRET / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET",
          },
        ],
      };
    }

    const pending = loadPending();
    const draft = pending[draft_id];

    if (!draft) {
      return {
        content: [{ type: "text", text: `找不到草稿 ${draft_id}，請先執行 stage_tweet。` }],
      };
    }

    if (draft.status !== "pending") {
      return {
        content: [{ type: "text", text: `草稿 ${draft_id} 狀態為「${draft.status}」，無法重複發布。` }],
      };
    }

    const { data } = await client.v2.tweet(draft.text);

    draft.status = "published";
    draft.publishedAt = new Date().toISOString();
    draft.tweetId = data.id;
    savePending(pending);

    return {
      content: [
        {
          type: "text",
          text: [
            `✅ 成功發文到 Twitter/X！`,
            `Tweet ID: ${data.id}`,
            `Draft ID: ${draft_id}`,
            `網址: https://x.com/i/web/status/${data.id}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "discard_tweet_draft",
  "取消並刪除待審推文草稿",
  {
    draft_id: z.string().describe("要取消的 draft_id"),
  },
  async ({ draft_id }) => {
    const pending = loadPending();
    if (!pending[draft_id]) {
      return { content: [{ type: "text", text: `找不到草稿 ${draft_id}` }] };
    }
    const text = pending[draft_id].text;
    delete pending[draft_id];
    savePending(pending);
    return {
      content: [{ type: "text", text: `草稿 ${draft_id} 已取消。\n內容：${text.slice(0, 50)}...` }],
    };
  }
);

server.tool(
  "list_tweet_drafts",
  "列出所有待審中的推文草稿",
  {},
  async () => {
    const pending = loadPending();
    const entries = Object.entries(pending);

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "目前沒有待審草稿。" }] };
    }

    const lines = entries.map(
      ([id, d]) =>
        `[${d.status}] ${id}  ${d.charCount}字  ${d.createdAt.slice(0, 16)}\n  ${d.text.slice(0, 60)}${d.text.length > 60 ? "..." : ""}`
    );

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "get_twitter_profile",
  "取得目前授權帳號的 Twitter/X 基本資料",
  {},
  async () => {
    const client = getClient();
    if (!client) {
      return { content: [{ type: "text", text: "錯誤：Twitter 憑證未設定" }] };
    }

    const { data } = await client.v2.me({ "user.fields": ["username", "name", "description", "public_metrics"] });
    return {
      content: [
        {
          type: "text",
          text: [
            `@${data.username}（${data.name}）`,
            `簡介：${data.description || "無"}`,
            `追蹤者：${data.public_metrics?.followers_count ?? "N/A"}`,
            `推文數：${data.public_metrics?.tweet_count ?? "N/A"}`,
          ].join("\n"),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
