/*
 * The memories a turn carries without being asked: whatever the search finds
 * for the message being answered, and every stated preference. Before this the
 * model saw a memory only when it chose to search, and in a busy group it
 * rarely did, so "what does Halo like?" was answered from nothing. Scoped the
 * way the turn is: a group's own area in a group, the owner's own areas
 * everywhere else, so a group never sees the owner's private records.
 */

import type { AlgoliaSync } from "./algolia.ts";
import { pictureTextMatch } from "./attachments.ts";
import { groupAreas, now, OWN_AREA_CLAUSE, queueIndexJob, USER_ID } from "./db.ts";
import type { Db } from "./types.ts";

export type FactScope = { areaId: string } | { own: true };
export type MemoryFact = { title: string | null; content: string; tags: string[] };

/** The tag that marks a memory as a standing preference, carried on every turn in its scope. */
export const PREFERENCE_TAG = "preference";
const SEARCH_LIMIT = 8;
const PREFERENCE_LIMIT = 8;
const FACT_LIMIT = 12;
const CONTENT_LENGTH = 200;
/** A turn never waits long on this: past it the preferences go alone. */
const SEARCH_TIMEOUT_MS = 1500;

type FactRow = { id: string; title: string | null; content: string; tags_json: string };

type MemorySearch = Partial<Pick<AlgoliaSync, "searchMemories">>;

function scopeClause(scope: FactScope): { sql: string; params: string[] } {
  return "areaId" in scope
    ? { sql: "m.life_area_id=?", params: [scope.areaId] }
    : { sql: OWN_AREA_CLAUSE("m"), params: [] };
}

function trimmed(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CONTENT_LENGTH ? `${flat.slice(0, CONTENT_LENGTH - 1).trimEnd()}…` : flat;
}

function tagsOf(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function preferenceRows(db: Db, scope: FactScope): FactRow[] {
  const where = scopeClause(scope);
  return db.prepare(`
    SELECT m.id,m.title,m.content,m.tags_json FROM memories m
    WHERE m.user_id=? AND m.kind='fact' AND ${where.sql}
      AND EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE lower(value)=?)
    ORDER BY m.updated_at DESC LIMIT ?
  `).all(USER_ID, ...where.params, PREFERENCE_TAG, PREFERENCE_LIMIT) as FactRow[];
}

/** Hydrates ranked ids from SQLite inside the scope, so a hit from outside it is dropped rather than trusted. */
function hydrate(db: Db, ids: string[], scope: FactScope): FactRow[] {
  if (!ids.length) return [];
  const where = scopeClause(scope);
  const rows = db.prepare(`
    SELECT m.id,m.title,m.content,m.tags_json FROM memories m
    WHERE m.user_id=? AND m.kind IN ('fact','note') AND ${where.sql} AND m.id IN (${ids.map(() => "?").join(",")})
  `).all(USER_ID, ...where.params, ...ids) as FactRow[];
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.flatMap(memoryId => byId.get(memoryId) ?? []);
}

/** Words worth matching on in a lexical scan: the longest few, so "the" and "what" do not match everything. */
function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? [];
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

function scanRows(db: Db, text: string, scope: FactScope): FactRow[] {
  const words = keywords(text);
  if (!words.length) return [];
  const where = scopeClause(scope);
  // A receipt's vendor or total is in the memory's pictures, not its text.
  const match = words.map(() => `(lower(m.title) LIKE ? OR lower(m.content) LIKE ? OR ${pictureTextMatch("m", "?")})`).join(" OR ");
  return db.prepare(`
    SELECT m.id,m.title,m.content,m.tags_json FROM memories m
    WHERE m.user_id=? AND m.kind IN ('fact','note') AND ${where.sql} AND (${match})
    ORDER BY m.updated_at DESC LIMIT ?
  `).all(USER_ID, ...where.params, ...words.flatMap(word => [`%${word}%`, `%${word}%`, `%${word}%`]), SEARCH_LIMIT) as FactRow[];
}

async function searchedRows(db: Db, search: MemorySearch, text: string, scope: FactScope): Promise<FactRow[]> {
  if (!text.trim()) return [];
  if (!search.searchMemories) return scanRows(db, text, scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ids = await Promise.race([
      search.searchMemories(text.slice(0, 300), {
        limit: SEARCH_LIMIT * 2,
        // hydrate() is what fences the scope; the filter keeps group hits from crowding out the owner's.
        ...("areaId" in scope
          ? { life_area_id: scope.areaId }
          : { exclude_life_area_ids: groupAreas(db).map(area => area.id) }),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("memory search timed out")), SEARCH_TIMEOUT_MS);
      }),
    ]);
    return hydrate(db, ids, scope).slice(0, SEARCH_LIMIT);
  } catch (error) {
    // Local mode has the method but no client; SQLite answers instead. A slow
    // or failing search costs the turn its matches, never its reply.
    return error instanceof Error && /not configured/.test(error.message) ? scanRows(db, text, scope) : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Words that mark a saved fact as a standing preference rather than a one-off. */
const PREFERENCE_WORDS = /\b(?:likes?|loves?|prefers?|preferences?|hates?|dislikes?|favou?rites?|allergic|allergy|allergies|can't stand|doesn't eat|don't eat|vegan|vegetarian|always wants?|never wants?)\b/i;

/**
 * Facts that read like preferences but are not tagged as one yet. Listed on a
 * dry run; with `apply`, each gets the tag and a reindex job, so the search
 * projection carries the tag too. Run through the server so it is the one
 * writer, never as a second process beside it.
 */
export function tagPreferences(db: Db, apply: boolean): Array<{ id: string; title: string | null; content: string }> {
  const rows = db.prepare(`
    SELECT id,title,content,tags_json FROM memories
    WHERE user_id=? AND kind='fact'
      AND NOT EXISTS (SELECT 1 FROM json_each(memories.tags_json) WHERE lower(value)=?)
    ORDER BY created_at
  `).all(USER_ID, PREFERENCE_TAG) as FactRow[];
  const candidates = rows.filter(row => PREFERENCE_WORDS.test(`${row.title ?? ""} ${row.content}`));
  if (apply) {
    const update = db.prepare("UPDATE memories SET tags_json=?,updated_at=? WHERE id=? AND user_id=?");
    db.transaction(() => {
      for (const row of candidates) {
        update.run(JSON.stringify([...tagsOf(row.tags_json), PREFERENCE_TAG]), now(), row.id, USER_ID);
        queueIndexJob(db, "memory", row.id);
      }
    })();
  }
  return candidates.map(row => ({ id: row.id, title: row.title, content: trimmed(row.content) }));
}

/**
 * Up to a dozen memories for this turn: what the search finds for `text`
 * first, then the scope's preferences, each once, trimmed to a line or two.
 */
export async function relevantFacts(db: Db, search: MemorySearch, scope: FactScope, text: string): Promise<MemoryFact[]> {
  const [found, preferences] = [await searchedRows(db, search, text, scope), preferenceRows(db, scope)];
  const seen = new Set<string>();
  const facts: MemoryFact[] = [];
  for (const row of [...found, ...preferences]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    facts.push({ title: row.title ? trimmed(row.title) : null, content: trimmed(row.content), tags: tagsOf(row.tags_json) });
    if (facts.length === FACT_LIMIT) break;
  }
  return facts;
}
