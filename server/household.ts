import { ensureGroupLifeArea, id, now, USER_ID } from "./db.ts";
import { HOUSEHOLD_ADDRESS, isVoiceAddress } from "./group-thread.ts";
import type { GroupScope } from "./tool-executor.ts";
import type { Db } from "./types.ts";

/*
 * The Echo is a shared room, so what it can reach is fenced the way a group
 * chat is: one life area, filed against one thread, and every tool call it
 * makes carries that as its `scope`. The executor's existing fences (by-id
 * reads, area-filtered lists, `OWNER_ONLY_TOOLS`) then apply unchanged. The
 * thread is a stand-in with no messages and no provider; see `HOUSEHOLD_ADDRESS`
 * for why nothing is ever sent to it.
 */

export const HOUSEHOLD_AREA_NAME = "Household";

function newConversationId(): string {
  return `alg_cnv_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The Household thread and life area, created on first use and the same ones every time after. */
export function householdScope(db: Db): GroupScope {
  const timestamp = now();
  db.prepare(`
    INSERT OR IGNORE INTO channel_threads(id,user_id,channel,address,agent_conversation_id,display_name,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id("thread"), USER_ID, "web", HOUSEHOLD_ADDRESS, newConversationId(), HOUSEHOLD_AREA_NAME, timestamp, timestamp);
  const thread = db.prepare("SELECT id FROM channel_threads WHERE user_id=? AND channel='web' AND address=?")
    .get(USER_ID, HOUSEHOLD_ADDRESS) as { id: string };
  const area = ensureGroupLifeArea(db, thread.id, HOUSEHOLD_AREA_NAME);
  return { lifeAreaId: area.id, threadId: thread.id, lifeAreaIsNew: false };
}

/** Whether a thread is a voice surface, so the background jobs that write to every group's thread can skip it. */
export function isVoiceThread(db: Db, threadId: string): boolean {
  const row = db.prepare("SELECT address FROM channel_threads WHERE id=? AND user_id=?")
    .get(threadId, USER_ID) as { address: string } | undefined;
  return Boolean(row && isVoiceAddress(row.address));
}
