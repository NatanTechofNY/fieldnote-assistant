import { z } from "zod";
import { USER_ID, id, now, queueIndexJob } from "../db.ts";
import { failure, success } from "../http.ts";
import { currentConversation, messageJson } from "../serializers.ts";
import { executeAgentTool } from "../tool-executor.ts";
import { type MessageRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

export function registerAgentRoutes({ app, db, search }: RouteContext): void {
  app.post("/api/agent/tools/:name", async (req, res) => {
    const input = z.record(z.string(), z.unknown()).parse(req.body);
    try {
      return success(res, await executeAgentTool(db, search, req.params.name, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent tool failed";
      if (/user-classified|override confirmation|confirmation is required/i.test(message)) {
        return failure(res, 409, message);
      }
      // A miss and an unknown tool are both caller mistakes. Leaving them to the
      // generic handler reported them as 500s, which told the agent to retry a
      // request that could never succeed and buried real faults in the logs.
      if (/ not found$/i.test(message)) return failure(res, 404, message);
      if (/^Unsupported tool: /.test(message)) return failure(res, 400, message);
      // An unconfigured integration is the same shape of problem: retrying cannot
      // help, and the agent should say the tool is unavailable instead.
      if (/ is not configured$/i.test(message)) return failure(res, 503, message);
      // An upstream refusal names its own cause — a rotated token, a missing
      // license, a rate limit — and the generic handler would replace all of that
      // with "Internal server error", leaving the agent nothing to report.
      if (/^Atlassian /.test(message)) return failure(res, 502, message);
      throw error;
    }
  });
  app.post("/api/chat", (req, res) => {
    const body = z.object({ content: z.string().trim().min(1).max(20_000) }).strict().parse(req.body);
    const conversationId = currentConversation(db);
    const timestamp = now();
    const createMatch = body.content.match(/^(?:add|create)(?: a)? todo[:\s]+(.+)$/i);
    let action: string | undefined;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO messages(
          id,conversation_id,role,content,tool_name,tool_args_json,tool_result_json,created_at
        ) VALUES(?,?,'user',?,NULL,NULL,NULL,?)
      `).run(id("message"), conversationId, body.content, timestamp);
      let assistantContent = "I saved your message. I can also create a todo with “create todo: …”.";
      if (createMatch?.[1]) {
        const title = createMatch[1].trim().slice(0, 300);
        const todoId = id("todo");
        db.prepare(`
          INSERT INTO todos(
            id,user_id,title,notes,extra_reminders_json,priority,status,created_at,updated_at
          ) VALUES(?,?,?,NULL,'[]','normal','pending',?,?)
        `).run(todoId, USER_ID, title, timestamp, timestamp);
        queueIndexJob(db, "todo", todoId);
        db.prepare(`
          INSERT INTO messages(
            id,conversation_id,role,content,tool_name,tool_args_json,tool_result_json,created_at
          ) VALUES(?,?,'tool',?,'create_todo',?,?,?)
        `).run(id("message"), conversationId, `Created todo: ${title}`,
          JSON.stringify({ title }), JSON.stringify({ id: todoId, title }), timestamp);
        assistantContent = `Created “${title}” in your todo list.`;
        action = "create_todo";
      }
      db.prepare(`
        INSERT INTO messages(
          id,conversation_id,role,content,tool_name,tool_args_json,tool_result_json,created_at
        ) VALUES(?,?,'assistant',?,NULL,NULL,NULL,?)
      `).run(id("message"), conversationId, assistantContent, timestamp);
      db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(timestamp, conversationId);
    })();
    if (action) search.flushSoon();
    const messages = db.prepare(`
      SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid
    `).all(conversationId) as MessageRow[];
    return success(res, { messages: messages.map(messageJson), ...(action ? { action } : {}) });
  });
}
