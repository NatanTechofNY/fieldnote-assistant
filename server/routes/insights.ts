import { z } from "zod";
import { success } from "../http.ts";
import { buildInsights, type InsightsScope } from "../insights.ts";
import type { RouteContext } from "./context.ts";

/*
 * The Insights page's one read. It is derived from SQLite on every request and
 * writes nothing, so there is no index job and no agent tool for it; the
 * session gate in front of it is the only access rule it needs.
 */
export function registerInsightsRoutes({ app, db }: RouteContext): void {
  app.get("/api/insights", (req, res) => {
    const query = z.object({
      days: z.enum(["30", "90", "365"]).default("30"),
      /** `mine`: the owner's own records, leaving out every group chat's area. */
      scope: z.enum(["mine"]).optional(),
      life_area_id: z.string().max(100).optional(),
    }).parse(req.query);
    const scope: InsightsScope = query.life_area_id
      ? { kind: "area", id: query.life_area_id }
      : query.scope === "mine" ? { kind: "mine" } : { kind: "all" };
    return success(res, buildInsights(db, { days: Number(query.days), scope }));
  });
}
