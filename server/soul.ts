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

export function setGroupSoul(db: Db, areaId: string, soul: string | null): string | null {
  const next = cleaned(soul);
  db.prepare("UPDATE life_areas SET soul=?,updated_at=? WHERE id=? AND user_id=?").run(next, now(), areaId, USER_ID);
  return next;
}

/** Each field left undefined keeps its value. */
export function setGroupSettings(
  db: Db,
  areaId: string,
  changes: { replyMode?: ReplyMode; assistantNickname?: string | null },
): GroupVoice {
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
