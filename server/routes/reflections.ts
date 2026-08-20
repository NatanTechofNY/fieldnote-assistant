import { z } from "zod";
import { USER_ID, id, now, queueIndexJob } from "../db.ts";
import { type FiscalQuarter, currentFiscalQuarter } from "../fiscal-quarter.ts";
import { failure, success } from "../http.ts";
import { getNotificationPreferences } from "../integrations.ts";
import { type ReflectionPreset, reflectionPeriod } from "../reflection-period.ts";
import { getReflectionEvidence, getReviewEvidence } from "../tool-executor.ts";
import type { RouteContext } from "./context.ts";

export function registerReflectionRoutes({ app, db, search, draftWithAgent }: RouteContext): void {
  const resolveReviewPeriod = (input: unknown) => {
    const preferences = getNotificationPreferences(db);
    const parsed = z.object({
      year: z.coerce.number().int().min(2000).max(2100).optional(),
      quarter: z.coerce.number().int().min(1).max(4).optional(),
    }).parse(input);
    const current = currentFiscalQuarter(preferences.timezone);
    return {
      year: parsed.year ?? current.year,
      quarter: (parsed.quarter ?? current.quarter) as FiscalQuarter,
      timezone: preferences.timezone,
    };
  };

  const resolveReflection = (input: unknown) => {
    const raw = z.record(z.string(), z.unknown()).parse(input);
    const list = (key: string): string[] => {
      const value = raw[key];
      if (Array.isArray(value)) return value.map(String).filter(Boolean).slice(0, 100);
      return typeof value === "string" && value ? value.split(",").map(item => item.trim()).filter(Boolean).slice(0, 100) : [];
    };
    const preset = z.enum(["today", "week", "month", "custom"]).parse(raw.preset || "month") as ReflectionPreset;
    const startDate = typeof raw.start_date === "string" ? raw.start_date : undefined;
    const endDate = typeof raw.end_date === "string" ? raw.end_date : undefined;
    if (preset === "custom") {
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }).refine(value => value.startDate <= value.endDate, {
        message: "start_date must be on or before end_date",
      }).parse({ startDate, endDate });
    }
    const sources = list("sources");
    sources.forEach(source => z.enum(["memories", "todos"]).parse(source));
    const timezone = getNotificationPreferences(db).timezone;
    return {
      period: reflectionPeriod(preset, timezone, { startDate, endDate }),
      filters: {
        lifeAreaIds: list("life_area_ids"),
        categoryIds: list("category_ids"),
        sources: (sources.length ? sources : ["memories", "todos"]) as Array<"memories" | "todos">,
      },
    };
  };

  app.get("/api/reflections/period", (req, res) => {
    const { period, filters } = resolveReflection(req.query);
    return success(res, getReflectionEvidence(db, period, filters));
  });

  const reflectionSelectionBody = z.object({
      scope_key: z.string().regex(/^reflection:[a-f0-9]{20}$/),
      items: z.array(z.object({
        type: z.enum(["memory", "todo"]),
        id: z.string().min(1).max(100),
        selected: z.boolean(),
      })).min(1).max(500),
    }).strict();
  const applyReflectionSelections = (body: z.infer<typeof reflectionSelectionBody>) => {
    const changed = db.transaction(() => body.items.map(item => {
      const table = item.type === "memory" ? "memories" : "todos";
      if (!db.prepare(`SELECT 1 found FROM ${table} WHERE id=? AND user_id=?`).get(item.id, USER_ID)) {
        throw new Error(`${item.type} not found: ${item.id}`);
      }
      if (item.selected) {
        db.prepare(`
          INSERT OR IGNORE INTO reflection_selections(user_id,scope_key,entity_type,entity_id,created_at)
          VALUES(?,?,?,?,?)
        `).run(USER_ID, body.scope_key, item.type, item.id, now());
      } else {
        db.prepare(`
          DELETE FROM reflection_selections WHERE user_id=? AND scope_key=? AND entity_type=? AND entity_id=?
        `).run(USER_ID, body.scope_key, item.type, item.id);
      }
      return item;
    }))();
    return changed;
  };

  app.patch("/api/reflections/selections", (req, res) => {
    const body = reflectionSelectionBody.parse(req.body);
    return success(res, { changed: applyReflectionSelections(body) });
  });

  app.patch("/api/reflections/exclusions", (req, res) => {
    const legacy = z.object({
      scope_key: z.string().regex(/^reflection:[a-f0-9]{20}$/),
      items: z.array(z.object({
        type: z.enum(["memory", "todo"]),
        id: z.string().min(1).max(100),
        excluded: z.boolean(),
      })).min(1).max(500),
    }).strict().parse(req.body);
    const body = {
      scope_key: legacy.scope_key,
      items: legacy.items.map(item => ({ type: item.type, id: item.id, selected: !item.excluded })),
    };
    const changed = applyReflectionSelections(body);
    return success(res, { changed });
  });

  app.post("/api/reflections/draft", async (req, res) => {
    const { period, filters } = resolveReflection(req.body);
    const evidence = getReflectionEvidence(db, period, filters);
    if (!evidence.memories.length && !evidence.todos.length) {
      return failure(res, 400, "Select at least one memory or completed todo before drafting a reflection");
    }
    const prompt = [
      `Draft a personal reflection for ${period.label}.`,
      `Call get_reflection_evidence with preset=${period.preset}, start_date=${period.startDate}, end_date=${period.endDate}, timezone=${period.timezone},`,
      `life_area_ids=${JSON.stringify(filters.lifeAreaIds)}, category_ids=${JSON.stringify(filters.categoryIds)}, sources=${JSON.stringify(filters.sources)}.`,
      "Use only the rows in the returned todos and memories arrays, which are the ones I selected. Ignore todo_candidates and memory_candidates: those cover the whole range, including what I chose to leave out.",
      "Organize concise grounded notes under Highlights, Progress, Lessons, and Next steps.",
      "Include the supporting memory or todo title in parentheses when available. Never invent outcomes.",
      'Return only valid JSON shaped exactly as {"content":"Markdown reflection","tags":["up to five concise tags"],"mood_score":1,"mood_label":"concise mood"}.',
      "Suggest tags and an overall mood from the evidence. mood_score must be an integer from 1 to 5, or null with mood_label null when the evidence does not support a mood.",
    ].join(" ");
    const text = await draftWithAgent(prompt, `reflection:${evidence.scope_key}`, {
      context: {
        kind: "reflection_generation",
        label: period.label,
        selectedCount: evidence.memories.length + evidence.todos.length,
      },
    });
    const suggestionSchema = z.object({
      content: z.string().trim().min(1),
      tags: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
      mood_score: z.number().int().min(1).max(5).nullable().default(null),
      mood_label: z.string().trim().min(1).max(60).nullable().default(null),
    });
    let suggestion: z.infer<typeof suggestionSchema> = {
      content: text,
      tags: [],
      mood_score: null,
      mood_label: null,
    };
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
      const validated = suggestionSchema.safeParse(parsed);
      if (validated.success) suggestion = validated.data;
    } catch {
      // Preserve a useful plain-text draft when the model does not return valid JSON.
    }
    return success(res, {
      ...evidence,
      generated: true,
      generated_draft: {
        title: `${period.label} reflection`,
        ...suggestion,
      },
    });
  });

  app.post("/api/reflections/draft/save", (req, res) => {
    const body = z.object({
      content: z.string().trim().min(1).max(100_000),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
      mood_score: z.number().int().min(1).max(5).nullable().default(null),
      mood_label: z.string().trim().min(1).max(60).nullable().default(null),
    }).passthrough().parse(req.body);
    const { period, filters } = resolveReflection(req.body);
    const evidence = getReflectionEvidence(db, period, filters);
    const tags = [...new Set([
      "reflection-draft",
      evidence.scope_key,
      ...body.tags.filter(tag => tag !== "reflection-draft" && !tag.startsWith("reflection:")),
    ])];
    const timestamp = now();
    const occurredAt = new Date(new Date(period.endExclusive).getTime() - 1).toISOString();
    const lifeAreaId = filters.lifeAreaIds.length === 1 ? filters.lifeAreaIds[0] : null;
    let draftId = evidence.draft?.id as string | undefined;
    db.transaction(() => {
      if (draftId) {
        db.prepare(`
          UPDATE memories SET title=?,content=?,kind='journal',mood_label=?,mood_score=?,
            category_id=NULL,life_area_id=?,life_area_source=?,occurred_at=?,review_worthy=0,
            tags_json=?,updated_at=? WHERE id=? AND user_id=?
        `).run(`${period.label} reflection`, body.content, body.mood_score ? body.mood_label : null,
          body.mood_score, lifeAreaId, lifeAreaId ? "agent" : null,
          occurredAt, JSON.stringify(tags), timestamp, draftId, USER_ID);
      } else {
        draftId = id("memory");
        db.prepare(`
          INSERT INTO memories(
            id,user_id,title,content,kind,mood_label,mood_score,category_id,life_area_id,life_area_source,
            occurred_at,review_worthy,tags_json,created_at,updated_at
          ) VALUES(?,?,?,?,'journal',?,?,NULL,?,?,?,0,?,?,?)
        `).run(draftId, USER_ID, `${period.label} reflection`, body.content,
          body.mood_score ? body.mood_label : null, body.mood_score, lifeAreaId,
          lifeAreaId ? "agent" : null, occurredAt, JSON.stringify(tags), timestamp, timestamp);
      }
      queueIndexJob(db, "memory", draftId as string);
    })();
    search.flushSoon();
    return success(res, getReflectionEvidence(db, period, filters));
  });

  app.get("/api/reviews/quarter", (req, res) => {
    const period = resolveReviewPeriod(req.query);
    return success(res, getReviewEvidence(db, period.year, period.quarter, period.timezone));
  });

  app.patch("/api/reviews/evidence", (_req, res) => {
    return failure(res, 410, "Review classification mutation was retired; use scoped reflection exclusions");
  });

  app.post("/api/reviews/draft", async (req, res) => {
    const period = resolveReviewPeriod(req.body);
    const exclusions = z.object({
      exclude_memory_ids: z.array(z.string().max(100)).max(500).default([]),
      exclude_todo_ids: z.array(z.string().max(100)).max(500).default([]),
    }).parse(req.body);
    const evidence = getReviewEvidence(db, period.year, period.quarter, period.timezone);
    const includedMemories = evidence.memories.filter((memory) => !exclusions.exclude_memory_ids.includes(String(memory.id)));
    const includedTodos = evidence.todos.filter((todo) => !exclusions.exclude_todo_ids.includes(String(todo.id)));
    if (!includedMemories.length && !includedTodos.length) {
      return failure(res, 400, "Log a win or complete a Work todo before drafting this review");
    }
    const prompt = [
      `Draft my performance-review brag sheet for ${evidence.range.label}.`,
      `Call get_review_evidence with year=${period.year}, quarter=${period.quarter}, timezone=${period.timezone}.`,
      exclusions.exclude_memory_ids.length || exclusions.exclude_todo_ids.length
        ? `Exclude these evidence IDs from the draft: ${[...exclusions.exclude_memory_ids, ...exclusions.exclude_todo_ids].join(", ")}.`
        : "",
      "Use only the rows in the returned todos and memories arrays, which are already scoped to Work. Ignore todo_candidates and memory_candidates: those span every life area.",
      "Group concise bullets under Impact, Execution, Collaboration & leadership, and Growth.",
      "Include the supporting memory or todo title in parentheses after each bullet. Do not invent metrics or outcomes.",
    ].join(" ");
    const text = await draftWithAgent(prompt, `performance-review:${evidence.range.key}`);
    const tags = ["performance-review", evidence.range.key];
    const timestamp = now();
    let draftId = evidence.draft?.id as string | undefined;
    db.transaction(() => {
      if (draftId) {
        db.prepare(`
          UPDATE memories SET title=?,content=?,kind='note',life_area_id='area_work',
            life_area_source='agent',review_worthy=0,tags_json=?,updated_at=?
          WHERE id=? AND user_id=?
        `).run(`${evidence.range.label} performance review`, text, JSON.stringify(tags), timestamp, draftId, USER_ID);
      } else {
        draftId = id("memory");
        db.prepare(`
          INSERT INTO memories(
            id,user_id,title,content,kind,mood_label,mood_score,category_id,life_area_id,life_area_source,
            occurred_at,review_worthy,tags_json,created_at,updated_at
          ) VALUES(?,?,?,?, 'note',NULL,NULL,NULL,'area_work','agent',NULL,0,?,?,?)
        `).run(draftId, USER_ID, `${evidence.range.label} performance review`, text,
          JSON.stringify(tags), timestamp, timestamp);
      }
      queueIndexJob(db, "memory", draftId as string);
    })();
    search.flushSoon();
    return success(res, {
      ...getReviewEvidence(db, period.year, period.quarter, period.timezone),
      generated: true,
    });
  });
}
