import { z } from "zod";
import { success } from "../http.ts";
import { buildInsights, type InsightsScope } from "../insights.ts";
import type { RouteContext } from "./context.ts";

/*
 * The Insights page's one read. It is derived from SQLite on every request and
 * writes nothing, so there is no index job and no agent tool for it; the
 * session gate in front of it is the only access rule it needs.
 */
/*
 * The page recomputes a year of history on the one thread the workers and every
 * other request share, and a person flicking between ranges asks for the same
 * three answers over and over, so a result is kept briefly. Nothing here is
 * written back, and a few seconds' age on a trend is not a thing anyone can tell.
 */
const CACHE_MS = 30_000;
const cache = new WeakMap<object, Map<string, { at: number; value: ReturnType<typeof buildInsights> }>>();

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
    const key = `${query.days}:${scope.kind}:${scope.kind === "area" ? scope.id : ""}`;
    const kept = cache.get(db) ?? new Map();
    cache.set(db, kept);
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return success(res, hit.value);
    const value = buildInsights(db, { days: Number(query.days), scope });
    kept.set(key, { at: Date.now(), value });
    return success(res, value);
  });
}
