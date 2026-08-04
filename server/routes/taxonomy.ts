import { USER_ID, id, now, queueIndexJob } from "../db.ts";
import { failure, success } from "../http.ts";
import { categoryCreate, lifeAreaCreate } from "../schemas.ts";
import type { RouteContext } from "./context.ts";

export function registerTaxonomyRoutes({ app, db, search }: RouteContext): void {
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
        CASE WHEN slug IN ('work','personal','side-project') THEN 1 ELSE 0 END is_builtin
      FROM life_areas WHERE user_id=? ORDER BY
        CASE slug WHEN 'work' THEN 0 WHEN 'personal' THEN 1 WHEN 'side-project' THEN 2 ELSE 3 END,name
    `).all(USER_ID);
    return success(res, rows);
  });
  app.post("/api/life-areas", (req, res) => {
    const body = lifeAreaCreate.parse(req.body);
    const base = body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
    let slug = base;
    let suffix = 2;
    while (db.prepare("SELECT 1 found FROM life_areas WHERE user_id=? AND slug=?").get(USER_ID, slug)) {
      slug = `${base}-${suffix++}`;
    }
    const areaId = id("area");
    const timestamp = now();
    db.prepare(`
      INSERT INTO life_areas(id,user_id,slug,name,color,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(areaId, USER_ID, slug, body.name, body.color, timestamp, timestamp);
    return success(res, { id: areaId, slug, ...body, is_builtin: 0 }, 201);
  });
  app.patch("/api/life-areas/:id", (req, res) => {
    const body = lifeAreaCreate.partial().refine(value => Object.keys(value).length > 0).parse(req.body);
    const current = db.prepare("SELECT id,slug,name,color FROM life_areas WHERE id=? AND user_id=?")
      .get(req.params.id, USER_ID) as { id: string; slug: string; name: string; color: string } | undefined;
    if (!current) return failure(res, 404, "Life area not found");
    db.prepare("UPDATE life_areas SET name=?,color=?,updated_at=? WHERE id=? AND user_id=?")
      .run(body.name ?? current.name, body.color ?? current.color, now(), current.id, USER_ID);
    return success(res, {
      id: current.id,
      slug: current.slug,
      name: body.name ?? current.name,
      color: body.color ?? current.color,
      is_builtin: ["work", "personal", "side-project"].includes(current.slug) ? 1 : 0,
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
