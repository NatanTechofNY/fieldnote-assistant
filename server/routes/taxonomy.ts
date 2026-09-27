import { z } from "zod";
import { USER_ID, id, lifeAreaSlug, now, queueIndexJob, renameLifeArea } from "../db.ts";
import { refreshRosterMemory } from "../group-members.ts";
import { failure, success } from "../http.ts";
import { categoryCreate, lifeAreaCreate, lifeAreaPatch } from "../schemas.ts";
import { assertUsableNickname } from "../soul.ts";
import { NO_TEXT_FALLBACK } from "../agent-runner.ts";
import { composeGroupProfileTurn, groupProfile, groupProfileState, PROFILE_MAX, setGroupProfile } from "../profile.ts";
import type { RouteContext } from "./context.ts";

/**
 * What a group chat's area carries beyond its name: its check-ins — the two
 * local times, whether the owner gets a copy, the owner's wording for each ask
 * — and how the assistant behaves there: the group's Soul, what the group
 * calls it, and whether it answers only when named. Read and written together;
 * only an area a group owns may have any of them.
 */
const GROUP_FIELDS = [
  "morning_checkin_time",
  "evening_checkin_time",
  "checkin_copy_to_owner",
  "morning_checkin_prompt",
  "evening_checkin_prompt",
  "soul",
  "assistant_nickname",
  "reply_mode",
] as const;

export function registerTaxonomyRoutes({ app, db, search, draftWithAgent }: RouteContext): void {
  app.get("/api/categories", (_req, res) => {
    const rows = db.prepare(`
      SELECT id,kind,name,color,icon FROM categories WHERE user_id=? ORDER BY kind,name
    `).all(USER_ID);
    return success(res, rows);
  });
  app.post("/api/categories", (req, res) => {
    const body = categoryCreate.parse(req.body);
    const categoryId = id("cat");
    const timestamp = now();
    db.prepare(`
      INSERT INTO categories(id,user_id,kind,name,color,icon,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(categoryId, USER_ID, body.kind, body.name, body.color, body.icon ?? null, timestamp, timestamp);
    return success(res, { id: categoryId, ...body, icon: body.icon ?? null }, 201);
  });
  app.patch("/api/categories/:id", (req, res) => {
    const body = categoryCreate.partial().refine((value) => Object.keys(value).length > 0).parse(req.body);
    const current = db.prepare("SELECT * FROM categories WHERE id=? AND user_id=?").get(req.params.id, USER_ID) as
      | { id: string; kind: string; name: string; color: string; icon: string | null }
      | undefined;
    if (!current) return failure(res, 404, "Category not found");
    db.prepare(`
      UPDATE categories SET kind=?,name=?,color=?,icon=?,updated_at=? WHERE id=? AND user_id=?
    `).run(body.kind ?? current.kind, body.name ?? current.name, body.color ?? current.color,
      body.icon === undefined ? current.icon : body.icon, now(), current.id, USER_ID);
    const updated = db.prepare("SELECT id,kind,name,color,icon FROM categories WHERE id=?").get(current.id);
    return success(res, updated);
  });
  app.delete("/api/categories/:id", (req, res) => {
    const result = db.prepare("DELETE FROM categories WHERE id=? AND user_id=?").run(req.params.id, USER_ID);
    return result.changes ? success(res, { id: req.params.id }) : failure(res, 404, "Category not found");
  });

  app.get("/api/life-areas", (_req, res) => {
    const rows = db.prepare(`
      SELECT id,slug,name,color,
        CASE WHEN slug IN ('work','personal','side-project') THEN 1 ELSE 0 END is_builtin,
        CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END is_group,
        ${GROUP_FIELDS.join(",")},profile,profile_updated_at
      FROM life_areas WHERE user_id=? ORDER BY
        CASE slug WHEN 'work' THEN 0 WHEN 'personal' THEN 1 WHEN 'side-project' THEN 2 ELSE 3 END,name
    `).all(USER_ID);
    return success(res, rows);
  });
  /*
   * A group's profile, beside its Soul: the owner can correct it, or have it
   * rewritten now from the group's roster and facts rather than overnight.
   */
  const groupArea = (areaId: string) => db.prepare("SELECT id,thread_id FROM life_areas WHERE id=? AND user_id=?")
    .get(areaId, USER_ID) as { id: string; thread_id: string | null } | undefined;
  app.put("/api/life-areas/:id/profile", (req, res) => {
    const { profile } = z.object({ profile: z.string().max(PROFILE_MAX).nullable() }).strict().parse(req.body);
    const area = groupArea(req.params.id);
    if (!area?.thread_id) return failure(res, 404, "Group chat not found");
    setGroupProfile(db, area.id, profile);
    return success(res, groupProfile(db, area.id));
  });
  app.post("/api/life-areas/:id/profile/refresh", async (req, res) => {
    const area = groupArea(req.params.id);
    if (!area?.thread_id) return failure(res, 404, "Group chat not found");
    if (groupProfileState(db, area.id) === "empty") return failure(res, 409, "Nothing has been saved about this group yet to write a profile from");
    let text: string;
    try {
      text = await draftWithAgent(composeGroupProfileTurn(db, area.id), `profile:${area.id}`, {
        context: { kind: "group_profile_refresh", lifeAreaId: area.id, threadId: area.thread_id },
      });
    } catch (error) {
      console.warn("Group profile rewrite failed:", error instanceof Error ? error.message : error);
      return failure(res, 502, "The assistant could not write the profile right now; try again in a minute");
    }
    if (!text.trim() || text === NO_TEXT_FALLBACK) return failure(res, 502, "The assistant returned no profile; try again in a minute");
    setGroupProfile(db, area.id, text);
    return success(res, groupProfile(db, area.id));
  });
  app.post("/api/life-areas", (req, res) => {
    const body = lifeAreaCreate.parse(req.body);
    const slug = lifeAreaSlug(db, body.name);
    const areaId = id("area");
    const timestamp = now();
    db.prepare(`
      INSERT INTO life_areas(id,user_id,slug,name,color,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(areaId, USER_ID, slug, body.name, body.color, timestamp, timestamp);
    return success(res, { id: areaId, slug, ...body, is_builtin: 0, is_group: 0 }, 201);
  });
  app.patch("/api/life-areas/:id", (req, res) => {
    const body = lifeAreaPatch.parse(req.body);
    const current = db.prepare(`
      SELECT id,slug,name,color,thread_id,${GROUP_FIELDS.join(",")}
      FROM life_areas WHERE id=? AND user_id=?
    `).get(req.params.id, USER_ID) as {
      id: string; slug: string; name: string; color: string; thread_id: string | null;
      morning_checkin_time: string | null; evening_checkin_time: string | null; checkin_copy_to_owner: 0 | 1;
      morning_checkin_prompt: string | null; evening_checkin_prompt: string | null;
      soul: string | null; assistant_nickname: string | null; reply_mode: "normal" | "named_only";
    } | undefined;
    if (!current) return failure(res, 404, "Life area not found");
    // The check-ins are texted into a group chat and the rest shape the
    // assistant there, so only an area a group owns can carry them.
    const groupSettings = GROUP_FIELDS.some(field => body[field] !== undefined);
    if (groupSettings && !current.thread_id) return failure(res, 400, "Only a group chat's area can have check-ins or a Soul");
    if (body.assistant_nickname) {
      try {
        assertUsableNickname(db, current.id, body.assistant_nickname);
      } catch (error) {
        return failure(res, 400, error instanceof Error ? error.message : "That nickname cannot be used");
      }
    }
    // The name is on every indexed record of the area, so a rename goes through
    // the helper that queues the rewrites; the colour lives only here.
    if (body.name !== undefined && body.name !== current.name) {
      renameLifeArea(db, current.id, body.name);
      refreshRosterMemory(db, current.id);
    }
    if (body.color !== undefined) {
      db.prepare("UPDATE life_areas SET color=?,updated_at=? WHERE id=? AND user_id=?")
        .run(body.color, now(), current.id, USER_ID);
    }
    // Each field keeps its value unless the patch names it; the copy switch is
    // stored as 0/1, and an emptied Soul is no Soul.
    const settings = Object.fromEntries(GROUP_FIELDS.map(field => {
      const next = body[field] === undefined ? current[field] : body[field];
      return [field, typeof next === "boolean" ? Number(next) : next === "" ? null : next];
    })) as Record<(typeof GROUP_FIELDS)[number], string | number | null>;
    if (groupSettings) {
      db.prepare(`
        UPDATE life_areas SET ${GROUP_FIELDS.map(field => `${field}=?`).join(",")},updated_at=? WHERE id=? AND user_id=?
      `).run(...GROUP_FIELDS.map(field => settings[field]), now(), current.id, USER_ID);
    }
    search.flushSoon();
    return success(res, {
      id: current.id,
      slug: current.slug,
      name: body.name ?? current.name,
      color: body.color ?? current.color,
      is_builtin: ["work", "personal", "side-project"].includes(current.slug) ? 1 : 0,
      is_group: current.thread_id ? 1 : 0,
      ...settings,
    });
  });
  app.delete("/api/life-areas/:id", (req, res) => {
    const current = db.prepare("SELECT id,slug FROM life_areas WHERE id=? AND user_id=?")
      .get(req.params.id, USER_ID) as { id: string; slug: string } | undefined;
    if (!current) return failure(res, 404, "Life area not found");
    if (["work", "personal", "side-project"].includes(current.slug)) {
      return failure(res, 409, "Default life areas cannot be removed");
    }
    db.transaction(() => {
      const todos = db.prepare("SELECT id FROM todos WHERE user_id=? AND life_area_id=?").all(USER_ID, current.id) as Array<{ id: string }>;
      const memories = db.prepare("SELECT id FROM memories WHERE user_id=? AND life_area_id=?").all(USER_ID, current.id) as Array<{ id: string }>;
      db.prepare("UPDATE todos SET life_area_id=NULL,life_area_source=NULL,updated_at=? WHERE user_id=? AND life_area_id=?").run(now(), USER_ID, current.id);
      db.prepare("UPDATE memories SET life_area_id=NULL,life_area_source=NULL,updated_at=? WHERE user_id=? AND life_area_id=?").run(now(), USER_ID, current.id);
      todos.forEach(todo => queueIndexJob(db, "todo", todo.id));
      memories.forEach(memory => queueIndexJob(db, "memory", memory.id));
      db.prepare("DELETE FROM life_areas WHERE id=? AND user_id=?").run(current.id, USER_ID);
    })();
    search.flushSoon();
    return success(res, { id: current.id });
  });
}
