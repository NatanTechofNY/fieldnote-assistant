import { z } from "zod";
import { USER_ID, id, likePattern, now, queueIndexJob } from "../db.ts";
import { failure, success } from "../http.ts";
import { currentConversation, enrichChannelMetadata, messageJson } from "../serializers.ts";
import { type MessageRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

export function registerConversationRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/conversations/current/messages", (_req, res) => {
    const conversationId = currentConversation(db);
    const rows = db.prepare(`
      SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid
    `).all(conversationId) as MessageRow[];
    return success(res, rows.map(messageJson));
  });
  app.get("/api/conversations/channels", (_req, res) => {
    const rows = db.prepare(`
      SELECT t.id,t.channel,t.address,t.created_at,t.updated_at,
        count(m.id) message_count,
        (SELECT content FROM channel_messages latest WHERE latest.thread_id=t.id
          ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1) last_message,
        (SELECT created_at FROM channel_messages latest WHERE latest.thread_id=t.id
          ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1) last_message_at
      FROM channel_threads t LEFT JOIN channel_messages m ON m.thread_id=t.id
      WHERE t.user_id=? GROUP BY t.id ORDER BY COALESCE(last_message_at,t.updated_at) DESC
    `).all(USER_ID) as Array<Record<string, unknown>>;
    return success(res, rows.map(row => ({
      id: row.id,
      channel: row.channel,
      address: row.address,
      messageCount: row.message_count,
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  });
  app.get("/api/conversations/channels/:id/messages", (req, res) => {
    const thread = db.prepare(`
      SELECT id FROM channel_threads WHERE id=? AND user_id=?
    `).get(req.params.id, USER_ID);
    if (!thread) return failure(res, 404, "Conversation not found");
    const rows = db.prepare(`
      SELECT * FROM channel_messages WHERE thread_id=? ORDER BY created_at,rowid
    `).all(req.params.id) as Array<Record<string, unknown>>;
    return success(res, rows.map(row => ({
      id: row.id,
      direction: row.direction,
      role: row.role,
      content: row.content,
      providerMessageId: row.provider_message_id,
      status: row.status,
      metadata: enrichChannelMetadata(
        db,
        row.role,
        row.content,
        JSON.parse(String(row.metadata_json || "{}")),
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  });
  app.get("/api/conversations/search", async (req, res) => {
    const input = z.object({
      q: z.string().trim().min(1).max(500),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);
    if (search.searchMessages) {
      try {
        const hits = await search.searchMessages(input.q, input.limit);
        return success(res, { source: "algolia" as const, hits });
      } catch {
        // SQLite remains authoritative and provides a bounded lexical fallback.
      }
    }
    const hits = db.prepare(`
      SELECT m.id objectID,m.thread_id threadId,t.channel,m.role,m.content,m.created_at
      FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
      WHERE t.user_id=? AND m.role IN ('user','assistant') AND lower(m.content) LIKE lower(?) ESCAPE '\\'
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?
    `).all(USER_ID, likePattern(input.q), input.limit);
    return success(res, { source: "sqlite" as const, hits });
  });
  app.post("/api/conversations/web/sync", (req, res) => {
    const body = z.object({
      conversationId: z.string().min(1).max(200).default("browser-agent"),
      /*
       * The conversation Agent Studio filed this sitting under. The browser owns
       * it because the chat widget sends it; without it the column held the
       * thread key, a value Agent Studio has never seen, so nothing in the
       * archive could be traced to a conversation on Algolia's side.
       */
      agentConversationId: z.string().min(1).max(200).optional(),
      messages: z.array(z.object({
        id: z.string().min(1).max(300),
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.record(z.string(), z.unknown())).max(100),
      }).strict()).max(500),
    }).strict().parse(req.body);
    const timestamp = now();
    const agentConversationId = body.agentConversationId ?? body.conversationId;
    let thread = db.prepare(`
      SELECT id FROM channel_threads WHERE user_id=? AND channel='web' AND address=?
    `).get(USER_ID, body.conversationId) as { id: string } | undefined;
    if (!thread) {
      thread = { id: id("thread") };
      db.prepare(`
        INSERT INTO channel_threads(
          id,user_id,channel,address,agent_conversation_id,created_at,updated_at
        ) VALUES(?,?,'web',?,?,?,?)
      `).run(thread.id, USER_ID, body.conversationId, agentConversationId, timestamp, timestamp);
    } else if (body.agentConversationId) {
      db.prepare("UPDATE channel_threads SET agent_conversation_id=?,updated_at=? WHERE id=?")
        .run(agentConversationId, timestamp, thread.id);
    }
    const upsert = db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'delivered',?,?,?)
      ON CONFLICT(provider_message_id) DO UPDATE SET
        content=excluded.content,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
    `);
    db.transaction(() => {
      for (const message of body.messages) {
        const text = message.parts
          .filter(part => part.type === "text" && typeof part.text === "string")
          .map(part => String(part.text))
          .join("\n")
          .trim();
        const toolNames = message.parts
          .filter(part => typeof part.type === "string" && String(part.type).startsWith("tool-"))
          .map(part => String(part.type).slice(5));
        upsert.run(
          id("channel_message"),
          thread!.id,
          message.role === "user" ? "inbound" : "outbound",
          message.role,
          text || (toolNames.length ? `Tools: ${toolNames.join(", ")}` : "(empty message)"),
          `web:${message.id}`,
          JSON.stringify({ parts: message.parts }),
          timestamp,
          timestamp,
        );
        const stored = db.prepare(
          "SELECT id FROM channel_messages WHERE provider_message_id=?",
        ).get(`web:${message.id}`) as { id: string };
        queueIndexJob(db, "channel_message", stored.id);
      }
      db.prepare("UPDATE channel_threads SET updated_at=? WHERE id=?").run(timestamp, thread!.id);
    })();
    search.flushSoon();
    return success(res, { threadId: thread.id, messages: body.messages.length });
  });
}
