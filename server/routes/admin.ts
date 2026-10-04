import { z } from "zod";
import { sweepOrphanedAttachmentFiles } from "../attachments.ts";
import { resetDatabase, seedDatabase } from "../db.ts";
import { success } from "../http.ts";
import { saveSearchPreferences } from "../integrations.ts";
import { tagPreferences } from "../memory-context.ts";
import type { RouteContext } from "./context.ts";

export function registerAdminRoutes({ app, db, search, agentStudio }: RouteContext): void {
  app.post("/api/admin/seed", (req, res) => {
    z.object({ confirmation: z.literal("SEED") }).strict().parse(req.body);
    const result = seedDatabase(db);
    // Seeding starts from an empty database, so the pictures it had go too.
    sweepOrphanedAttachmentFiles(db, { graceMs: 0 });
    search.flushSoon();
    return success(res, result);
  });
  app.post("/api/admin/reset", (req, res) => {
    z.object({ confirmation: z.literal("RESET") }).strict().parse(req.body);
    resetDatabase(db);
    return success(res, { reset: true, attachmentFilesRemoved: sweepOrphanedAttachmentFiles(db, { graceMs: 0 }) });
  });
  app.post("/api/admin/reindex", async (_req, res) => success(res, await search.reindex()));
  // Tags facts that read like preferences, so every turn carries them. A dry
  // run lists them; `apply: true` writes the tag and queues each for reindex.
  app.post("/api/admin/memories/tag-preferences", (req, res) => {
    const { apply } = z.object({ apply: z.boolean().default(false) }).strict().parse(req.body ?? {});
    const tagged = tagPreferences(db, apply);
    if (apply) search.flushSoon();
    return success(res, { applied: apply, count: tagged.length, memories: tagged });
  });
  app.post("/api/admin/algolia/setup", async (_req, res) => success(res, await search.setup()));
  // Flipping the toggle rewrites each index's semantic settings, so the setup
  // run has to happen here rather than waiting for the next manual
  // "Configure Algolia".
  app.put("/api/admin/algolia/neural-search", async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    saveSearchPreferences(db, { neuralSearchEnabled: enabled });
    try {
      const setup = await search.setup();
      return success(res, { enabled: search.neuralSearchEnabled(), setup });
    } catch (error) {
      // The preference is saved either way. Reporting the reachability failure
      // separately keeps the UI honest: the choice stuck, the indices did not
      // get it yet, and "Configure Algolia" will retry.
      return success(res, {
        enabled: search.neuralSearchEnabled(),
        setup: {
          configured: false,
          details: {
            error: error instanceof Error ? error.message.slice(0, 300) : "Algolia setup failed",
          },
        },
      });
    }
  });
  app.post("/api/admin/agent-studio/sync-tools", async (_req, res) =>
    success(res, await agentStudio.syncTools()));
}
