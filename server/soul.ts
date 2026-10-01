/*
 * The Soul: a short, editable description of how the assistant talks in a
 * conversation — tone, length, what to leave out, what the room finds funny.
 * The owner has one for their own chats (their line and the browser), and every
 * group chat has its own on its life area. The agent rewrites it as people give
 * it feedback, and the owner can edit either in Settings. Memories hold facts
 * about people; the Soul holds the voice. It is never indexed: it is read by id
 * on every turn, so there is no projection to keep in step.
 */

import { now, USER_ID } from "./db.ts";
import { dedupeLines } from "./dedupe.ts";
import type { Db } from "./types.ts";

export type ReplyMode = "normal" | "named_only";

export type GroupVoice = {
  soul: string | null;
  assistantNickname: string | null;
  replyMode: ReplyMode;
};

const cleaned = (soul: string | null | undefined) => soul?.trim() ? soul.trim() : null;

export function ownerSoul(db: Db): string | null {
  const row = db.prepare("SELECT soul FROM notification_preferences WHERE user_id=?").get(USER_ID) as { soul: string | null } | undefined;
  return cleaned(row?.soul);
}

export function setOwnerSoul(db: Db, soul: string | null): string | null {
  const next = cleaned(soul);
  db.prepare("UPDATE notification_preferences SET soul=?,updated_at=? WHERE user_id=?").run(next, now(), USER_ID);
  return next;
}

export function groupVoice(db: Db, areaId: string): GroupVoice {
  const row = db.prepare("SELECT soul,assistant_nickname,reply_mode FROM life_areas WHERE id=? AND user_id=?")
    .get(areaId, USER_ID) as { soul: string | null; assistant_nickname: string | null; reply_mode: ReplyMode } | undefined;
  return {
    soul: cleaned(row?.soul),
    assistantNickname: cleaned(row?.assistant_nickname),
    replyMode: row?.reply_mode ?? "normal",
  };
}

/** The group's voice for the area a thread's group owns, or null for a thread no group owns. */
export function groupVoiceForThread(db: Db, threadId: string): (GroupVoice & { areaId: string }) | null {
  const area = db.prepare("SELECT id FROM life_areas WHERE thread_id=? AND user_id=?").get(threadId, USER_ID) as { id: string } | undefined;
  return area ? { ...groupVoice(db, area.id), areaId: area.id } : null;
}

/** A group's Soul has no length cap, and a rule it already holds is never added twice. */
export function setGroupSoul(db: Db, areaId: string, soul: string | null): string | null {
  const next = cleaned(soul) ? cleaned(dedupeLines(soul as string)) : null;
  db.prepare("UPDATE life_areas SET soul=?,updated_at=? WHERE id=? AND user_id=?").run(next, now(), areaId, USER_ID);
  return next;
}

/**
 * Words people say all the time. A nickname counts as the assistant's name
 * wherever it appears, so one of these would make nearly every message "for"
 * it and undo both staying quiet and waiting to be named.
 */
const COMMON_WORDS = new Set([
  "a", "an", "and", "the", "i", "me", "my", "you", "your", "we", "us", "he", "she", "it", "they", "them",
  "is", "are", "was", "be", "do", "to", "of", "in", "on", "at", "for", "so", "no", "yes", "yeah", "yep", "nope",
  "ok", "okay", "lol", "lmao", "omg", "haha", "hi", "hey", "hello", "bro", "dude", "guys", "all", "what", "why",
  "how", "who", "when", "this", "that", "just", "like", "good", "thanks", "thank", "love", "bye", "night", "morning",
]);

/**
 * Refuses a nickname that would make ordinary talk address the assistant: a
 * common word, or the name of someone in the chat or on the trusted list —
 * "Halo" as the assistant's nickname would make every message about Halo one
 * the assistant must answer.
 */
export function assertUsableNickname(db: Db, areaId: string, nickname: string): void {
  const wanted = nickname.trim().toLowerCase();
  if (COMMON_WORDS.has(wanted)) throw new Error(`"${nickname}" is too common a word to answer to; pick a name people only use for the assistant`);
  const members = db.prepare(`
    SELECT gm.name FROM group_members gm JOIN life_areas la ON la.thread_id=gm.thread_id
    WHERE la.id=? AND la.user_id=? AND gm.name IS NOT NULL
  `).all(areaId, USER_ID) as Array<{ name: string }>;
  const trusted = db.prepare("SELECT trusted_contacts_json FROM notification_preferences WHERE user_id=?").get(USER_ID) as
    { trusted_contacts_json: string } | undefined;
  const contacts = ((): Array<{ name?: unknown }> => {
    try {
      const parsed = JSON.parse(trusted?.trusted_contacts_json ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed as Array<{ name?: unknown }> : [];
    } catch {
      return [];
    }
  })();
  const names = [...members.map(member => member.name), ...contacts.map(contact => String(contact.name ?? ""))];
  if (names.some(name => name.trim().toLowerCase() === wanted)) {
    throw new Error(`"${nickname}" is the name of someone in the chat; pick a different nickname`);
  }
}

/** Each field left undefined keeps its value; a nickname of null clears it. */
export function setGroupSettings(
  db: Db,
  areaId: string,
  changes: { replyMode?: ReplyMode; assistantNickname?: string | null },
): GroupVoice {
  if (changes.assistantNickname) assertUsableNickname(db, areaId, changes.assistantNickname);
  const current = groupVoice(db, areaId);
  db.prepare("UPDATE life_areas SET reply_mode=?,assistant_nickname=?,updated_at=? WHERE id=? AND user_id=?").run(
    changes.replyMode ?? current.replyMode,
    changes.assistantNickname === undefined ? current.assistantNickname : cleaned(changes.assistantNickname),
    now(),
    areaId,
    USER_ID,
  );
  return groupVoice(db, areaId);
}
