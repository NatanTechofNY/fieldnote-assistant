import { USER_ID } from "../db.ts";
import { success } from "../http.ts";
import { getNotificationPreferences } from "../integrations.ts";
import { groupProfile, groupProfileStatus, ownerProfile, ownerProfileStatus, type ProfileState } from "../profile.ts";
import { groupVoice, ownerSoul } from "../soul.ts";
import type { Db } from "../types.ts";
import type { RouteContext } from "./context.ts";

/*
 * What the assistant does without being asked, laid out per chat for the
 * History page: when it last read the conversation for facts, what it kept or
 * changed, and the Soul and profile it is working from. Everything here is read
 * out of rows the worker already wrote, so the route changes nothing and queues
 * no index job.
 */

/** How many memory sweeps of each chat are listed. */
const SWEEPS_PER_CHAT = 8;
/** How many app-composed digest drafts are listed. */
const DIGEST_DRAFTS = 15;
/** The runner's sentence for a turn that said nothing; it is not a summary of anything. */
const NO_TEXT = "I completed that request, but did not receive a text response.";

type DispatchRow = {
  id: string;
  scheduled_for: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SweepChange = { action: "created" | "updated"; memoryId: string | null; title: string };

export type SweepRun = {
  id: string;
  at: string;
  status: string;
  error: string | null;
  summary: string | null;
  changes: SweepChange[];
};

/** A key prefix as a range the unique index on the key can serve (":" + 1 is ";"). */
function keyRange(prefix: string): [string, string] {
  return [`${prefix}:`, `${prefix};`];
}

function parse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The memory a successful sweep write kept, as the person would name it. */
function changeOf(tool: string, metadataJson: string): SweepChange | null {
  if (tool !== "create_memory" && tool !== "update_memory") return null;
  const metadata = parse(metadataJson);
  const output = record(metadata.output);
  if (output.success !== true) return null;
  const input = record(metadata.input);
  const data = record(output.data);
  const patch = record(input.patch);
  const title = text(data.title) ?? text(patch.title) ?? text(input.title) ?? text(data.content)?.slice(0, 80) ?? "A memory";
  return {
    action: tool === "create_memory" ? "created" : "updated",
    memoryId: text(data.id) ?? text(input.id),
    title,
  };
}

function sweepRuns(db: Db, threadId: string): SweepRun[] {
  const dispatches = db.prepare(`
    SELECT id,scheduled_for,status,last_error,created_at,updated_at FROM scheduled_dispatches
    WHERE kind='memory_sweep' AND idempotency_key>=? AND idempotency_key<?
    ORDER BY scheduled_for DESC,rowid DESC LIMIT ?
  `).all(...keyRange(`memory_sweep:${threadId}`), SWEEPS_PER_CHAT) as DispatchRow[];
  if (!dispatches.length) return [];
  const sweepThread = db.prepare("SELECT id FROM channel_threads WHERE user_id=? AND channel='sms' AND address=?")
    .get(USER_ID, `sweep:${threadId}`) as { id: string } | undefined;
  const rowsBetween = db.prepare(`
    SELECT role,content,metadata_json FROM channel_messages
    WHERE thread_id=? AND role IN ('assistant','tool') AND created_at>=? AND created_at<=?
    ORDER BY created_at,rowid
  `);
  return dispatches.map(dispatch => {
    const changes: SweepChange[] = [];
    let summary: string | null = null;
    if (sweepThread) {
      // Sweeps run one at a time, so the rows filed while a dispatch was open are its own.
      const end = new Date(Date.parse(dispatch.updated_at) + (dispatch.status === "processing" ? 5 * 60_000 : 2_000)).toISOString();
      const rows = rowsBetween.all(sweepThread.id, dispatch.created_at, end) as Array<{ role: string; content: string; metadata_json: string }>;
      for (const row of rows) {
        if (row.role === "tool") {
          const change = changeOf(row.content, row.metadata_json);
          if (change) changes.push(change);
        } else if (row.content.trim() && row.content !== NO_TEXT) {
          summary = row.content.trim().slice(0, 300);
        }
      }
    }
    return {
      id: dispatch.id,
      at: dispatch.scheduled_for,
      status: dispatch.status,
      error: dispatch.last_error,
      summary,
      changes,
    };
  });
}

type ProfileRun = { at: string; status: string; note: string | null };

function lastProfileRun(db: Db, owner: string): ProfileRun | null {
  const row = db.prepare(`
    SELECT updated_at,status,last_error FROM scheduled_dispatches
    WHERE kind='profile_refresh' AND idempotency_key>=? AND idempotency_key<?
    ORDER BY scheduled_for DESC,rowid DESC LIMIT 1
  `).get(...keyRange(`profile_refresh:${owner}`)) as { updated_at: string; status: string; last_error: string | null } | undefined;
  return row ? { at: row.updated_at, status: row.status, note: row.last_error } : null;
}

export type BackgroundChat = {
  id: string;
  kind: "owner" | "group";
  name: string;
  soul: string | null;
  profile: string | null;
  profileUpdatedAt: string | null;
  profileState: ProfileState;
  lastProfileRun: ProfileRun | null;
  sweeps: SweepRun[];
};

export type DigestDraft = {
  id: string;
  kind: string;
  label: string | null;
  at: string;
  draft: string | null;
};

function digestDrafts(db: Db): DigestDraft[] {
  const rows = db.prepare(`
    SELECT m.id,m.role,m.content,m.metadata_json,m.created_at FROM channel_messages m
    JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND t.channel='sms' AND t.address LIKE 'digest:%' AND m.role IN ('user','assistant')
      AND m.status<>'failed'
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?
  `).all(USER_ID, DIGEST_DRAFTS * 3) as Array<{ id: string; role: string; content: string; metadata_json: string; created_at: string }>;
  const drafts: DigestDraft[] = [];
  // Newest first: an assistant row is the draft of the instruction just before it in time, which comes next in the list.
  let pending: string | null = null;
  for (const row of rows) {
    if (row.role === "assistant") {
      // Several assistant rows can precede one instruction (a retry); the newest, seen first, is the draft.
      pending ??= row.content === NO_TEXT ? null : row.content;
      continue;
    }
    const metadata = parse(row.metadata_json);
    drafts.push({
      id: row.id,
      kind: text(metadata.kind) ?? "digest",
      label: text(metadata.briefName) ?? text(metadata.date),
      at: row.created_at,
      draft: pending,
    });
    pending = null;
    if (drafts.length >= DIGEST_DRAFTS) break;
  }
  return drafts;
}

export function registerActivityRoutes({ app, db }: RouteContext): void {
  app.get("/api/activity/background", (_req, res) => {
    const preferences = getNotificationPreferences(db);
    const ownerThread = preferences.recipientPhone
      ? db.prepare("SELECT id FROM channel_threads WHERE user_id=? AND channel='sms' AND address=?")
        .get(USER_ID, preferences.recipientPhone) as { id: string } | undefined
      : undefined;
    const areas = db.prepare(`
      SELECT id,name,thread_id FROM life_areas WHERE user_id=? AND thread_id IS NOT NULL ORDER BY name
    `).all(USER_ID) as Array<{ id: string; name: string; thread_id: string }>;
    const ownerStored = ownerProfile(db);
    const chats: BackgroundChat[] = [{
      id: "owner",
      kind: "owner",
      name: "You",
      soul: ownerSoul(db),
      profile: ownerStored.profile,
      profileUpdatedAt: ownerStored.updatedAt,
      profileState: ownerProfileStatus(db),
      lastProfileRun: lastProfileRun(db, USER_ID),
      sweeps: ownerThread ? sweepRuns(db, ownerThread.id) : [],
    }, ...areas.map(area => {
      const stored = groupProfile(db, area.id);
      return {
        id: area.id,
        kind: "group" as const,
        name: area.name,
        soul: groupVoice(db, area.id).soul,
        profile: stored.profile,
        profileUpdatedAt: stored.updatedAt,
        profileState: groupProfileStatus(db, area.id),
        lastProfileRun: lastProfileRun(db, area.id),
        sweeps: sweepRuns(db, area.thread_id),
      };
    })];
    return success(res, { chats, digests: digestDrafts(db) });
  });
}
