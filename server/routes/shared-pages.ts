import { failure, success } from "../http.ts";
import { createPageFromInput, relatedPicturesResult, updatePageFromInput } from "../page-service.ts";
import { getPage, listPages, pageJson, pollResults, revokePage } from "../pages.ts";
import { pageCreate, pageUpdate } from "../schemas.ts";
import type { RouteContext } from "./context.ts";

/**
 * The Pages screen's API. Behind the sign-in gate, so it is the owner's view of
 * every page: the unauthenticated surface is `routes/public-pages.ts`. The
 * matching agent tools are `create_page` and friends in `tool-executor.ts`.
 */
export function registerSharedPageRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/pages", (req, res) => {
    const includeExpired = req.query.include_expired === "1" || req.query.include_expired === "true";
    return success(res, listPages(db, { includeExpired }).map(row => pageJson(db, row)));
  });

  app.post("/api/pages", async (req, res) => {
    const body = pageCreate.parse(req.body);
    const { page, wroteTodos } = await createPageFromInput(db, body);
    if (wroteTodos) search.flushSoon();
    return success(res, { ...pageJson(db, page), ...relatedPicturesResult(db, page) }, 201);
  });

  app.patch("/api/pages/:id", async (req, res) => {
    const body = pageUpdate.parse(req.body);
    const row = getPage(db, req.params.id);
    if (!row) return failure(res, 404, "Page not found");
    return success(res, pageJson(db, await updatePageFromInput(db, row, body)));
  });

  app.delete("/api/pages/:id", (req, res) => {
    const row = getPage(db, req.params.id);
    if (!row) return failure(res, 404, "Page not found");
    return success(res, pageJson(db, revokePage(db, row)));
  });

  app.get("/api/pages/:id/results", (req, res) => {
    const row = getPage(db, req.params.id);
    if (!row) return failure(res, 404, "Page not found");
    return success(res, pollResults(db, row));
  });
}
