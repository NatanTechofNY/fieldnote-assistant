import { authEnabled } from "../auth.ts";
import { success } from "../http.ts";
import type { RouteContext } from "./context.ts";

export function registerHealthRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/health", async (_req, res) => {
    // Unauthenticated callers are platform probes; they get liveness only, not
    // index names, record counts, or the Agent Studio agent id.
    if (!res.locals.authenticated) return success(res, { ok: true });
    const sqliteRecords = (db.prepare(`
      SELECT (SELECT count(*) FROM todos)+(SELECT count(*) FROM memories) records
    `).get() as { records: number }).records;
    const pending = (db.prepare(`
      SELECT count(*) count FROM index_jobs WHERE status IN ('pending','failed','processing')
    `).get() as { count: number }).count;
    return success(res, {
      sqlite: { ok: true, records: sqliteRecords },
      algolia: await search.health(),
      agentStudio: {
        configured: Boolean(process.env.ALGOLIA_AGENT_ID),
        ...(process.env.ALGOLIA_AGENT_ID ? { agentId: process.env.ALGOLIA_AGENT_ID } : {}),
      },
      auth: { enabled: authEnabled() },
      neuralSearch: { enabled: search.neuralSearchEnabled() },
      indices: {
        todos: process.env.ALGOLIA_TODO_INDEX || "devcon_assistant_todos",
        memories: process.env.ALGOLIA_MEMORY_INDEX || "devcon_assistant_memories",
        messages: process.env.ALGOLIA_MESSAGE_INDEX || "devcon_assistant_messages",
      },
      pendingIndexJobs: pending,
    });
  });
}
