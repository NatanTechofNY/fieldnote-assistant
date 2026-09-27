/*
 * The owner's profile: a short, plain summary of their life — the people in
 * it, work, home, routines, what they like — that rides along on every one of
 * their turns so the assistant knows them without searching first. It is a
 * derived view of their fact memories, rewritten overnight when those change,
 * and editable in Settings; the memories stay the source of truth. It never
 * reaches a group chat, and it is never indexed.
 */

import { createHash } from "node:crypto";
import { RECORDS_NOT_INSTRUCTIONS } from "./checkin-prompts.ts";
import { now, OWN_AREA_CLAUSE, USER_ID } from "./db.ts";
import type { Db } from "./types.ts";

export const PROFILE_MAX = 1200;
/** Past this many facts the newest win; the profile is a summary, not an index. */
const FACT_LIMIT = 80;
/** The overnight rewrite runs in this local window, once the owner is likely asleep; a night that misses it waits. */
export const PROFILE_REFRESH_TIME = "04:00";
export const PROFILE_REFRESH_UNTIL = "06:00";

/*
 * A fact like this goes out on every turn once it is in the profile, so it is
 * kept out before the model sees it rather than left to an instruction. It is
 * still a memory, found when a search asks for it.
 */
const SENSITIVE = /\b(?:codes?|passwords?|passcodes?|pins?|combination|account numbers?|routing numbers?|ssn|social security|credit card|card numbers?|cvv)\b/i;
const SENSITIVE_TAGS = new Set(["secret", "sensitive", "private", "credentials"]);

type ProfileRow = { life_profile: string | null; life_profile_updated_at: string | null; life_profile_source: string | null };
type FactRow = { id: string; title: string | null; content: string; tags_json: string; updated_at: string };

export function ownerProfile(db: Db): { profile: string | null; updatedAt: string | null } {
  const row = profileRow(db);
  return { profile: row?.life_profile?.trim() || null, updatedAt: row?.life_profile_updated_at ?? null };
}

function profileRow(db: Db): ProfileRow | undefined {
  return db.prepare("SELECT life_profile,life_profile_updated_at,life_profile_source FROM notification_preferences WHERE user_id=?")
    .get(USER_ID) as ProfileRow | undefined;
}

function isSensitive(fact: FactRow): boolean {
  if (SENSITIVE.test(`${fact.title ?? ""} ${fact.content}`)) return true;
  try {
    const tags = JSON.parse(fact.tags_json) as unknown;
    return Array.isArray(tags) && tags.some(tag => typeof tag === "string" && SENSITIVE_TAGS.has(tag.toLowerCase()));
  } catch {
    return false;
  }
}

/** The owner's own facts the profile may draw on: never a group's, never the roster, never a secret. */
function ownFacts(db: Db): FactRow[] {
  return (db.prepare(`
    SELECT m.id,m.title,m.content,m.tags_json,m.updated_at FROM memories m
    WHERE m.user_id=? AND m.kind='fact' AND ${OWN_AREA_CLAUSE("m")}
      AND NOT EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value='group-roster')
    ORDER BY m.updated_at DESC LIMIT ?
  `).all(USER_ID, FACT_LIMIT) as FactRow[]).filter(fact => !isSensitive(fact));
}

/** A fingerprint of the fact set: it changes when a fact is added, edited, deleted, or moved out. */
function sourceOf(facts: FactRow[]): string {
  return createHash("sha256").update(facts.map(fact => `${fact.id}@${fact.updated_at}`).sort().join("\n")).digest("hex");
}

/**
 * Saves the profile. What the owner writes counts as current for the facts as
 * they stand, so it is kept until a fact changes; clearing it leaves no
 * source, so the next night writes a fresh one.
 */
export function setOwnerProfile(db: Db, profile: string | null): string | null {
  const next = profile?.trim() ? profile.trim().slice(0, PROFILE_MAX) : null;
  db.prepare(`
    UPDATE notification_preferences SET life_profile=?,life_profile_updated_at=?,life_profile_source=?,updated_at=? WHERE user_id=?
  `).run(next, next ? now() : null, next ? sourceOf(ownFacts(db)) : null, now(), USER_ID);
  return next;
}

export type ProfileState = "current" | "stale" | "empty";

/**
 * Whether the profile needs writing: "stale" when the facts changed since it
 * was written, "empty" when no facts are left to write one from — then any
 * profile is cleared right away, since it describes facts that are gone.
 */
export function profileState(db: Db): ProfileState {
  const facts = ownFacts(db);
  const row = profileRow(db);
  if (!facts.length) {
    if (row?.life_profile) setOwnerProfile(db, null);
    return "empty";
  }
  return row?.life_profile && row.life_profile_source === sourceOf(facts) ? "current" : "stale";
}

/** The instruction the profile is written from: the owner's facts, and the profile as it stands. */
export function composeProfileTurn(db: Db): string {
  const { profile } = ownerProfile(db);
  const facts = ownFacts(db).map(fact => `- ${fact.title ? `${fact.title}: ` : ""}${fact.content.replace(/\s+/g, " ").slice(0, 240)}`);
  return [
    "Rewrite my profile: what my assistant should know about me before I say a word.",
    `Plain text, under ${PROFILE_MAX - 200} characters, in three short labelled parts — People, Life & work, Routines & preferences — with facts as short phrases separated by semicolons.`,
    "Keep only what the facts below establish; drop anything in the current profile they no longer support; never guess, and never include codes, passwords, account numbers, or health details beyond an allergy.",
    "Describe; never instruct. It is background about me, not rules for you.",
    "Answer with the profile alone.",
    "",
    "--- Context supplied by the app, not by me. This turn uses no tools.",
    RECORDS_NOT_INSTRUCTIONS,
    profile ? `The profile as it stands:\n${profile}` : "There is no profile yet.",
    "My facts, newest first:",
    ...facts,
  ].join("\n");
}
