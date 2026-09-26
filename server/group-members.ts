/**
 * Who is in a group chat. Sendblue lists every number in the conversation on
 * each inbound text, so the roster is kept from that list rather than from who
 * happens to have spoken; names and relationships come later, from the people
 * in the chat telling the assistant who they are.
 *
 * Three things are kept in step when someone is named: the member row, the
 * owner's trusted contacts (so the name follows the number into every group),
 * and one fact memory per group that says who is in it, so recall finds the
 * roster the same way it finds anything else the group asked to remember.
 */
import { getMemory, id, now, queueIndexJob, USER_ID } from "./db.ts";
import { getNotificationPreferences, getSendbluePublicConfig, upsertTrustedContact } from "./integrations.ts";
import { ASSISTANT_NAME, OWNER_SPEAKER_NAME, redactedNumber } from "./group-thread.ts";
import type { Db } from "./types.ts";

export type GroupMemberRow = {
  thread_id: string;
  phone: string;
  name: string | null;
  relationship: string | null;
  is_owner: 0 | 1;
  created_at: string;
  updated_at: string;
};

/** The tag the per-group roster memory carries, so it is found again rather than written twice. */
export const ROSTER_TAG = "group-roster";

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Files every number in the conversation as a member of the group's thread.
 * The Sendblue line itself is in the list and is left out; the recipient is
 * marked as the owner. Existing rows keep their names.
 *
 * `participants` is the provider's full list when it sent one, and then it is
 * the truth: someone no longer on it has left the group, and is dropped so the
 * room is not described with them still in it. `speaker` is always kept, as
 * whoever wrote the message is in the room whatever the list said.
 */
export function recordGroupParticipants(
  db: Db,
  threadId: string,
  lifeAreaId: string,
  participants: string[] | undefined,
  speaker: string | undefined,
): void {
  const ownerPhone = getNotificationPreferences(db).recipientPhone;
  const linePhone = getSendbluePublicConfig(db).fromPhone;
  const timestamp = now();
  const present = [...new Set([...participants ?? [], speaker])]
    .filter((phone): phone is string => Boolean(phone) && E164.test(phone as string) && phone !== linePhone);
  const upsert = db.prepare(`
    INSERT INTO group_members(thread_id,phone,name,relationship,is_owner,created_at,updated_at)
    VALUES(?,?,NULL,NULL,?,?,?)
    ON CONFLICT(thread_id,phone) DO UPDATE SET is_owner=excluded.is_owner,updated_at=excluded.updated_at
    WHERE group_members.is_owner<>excluded.is_owner
  `);
  db.transaction(() => {
    for (const phone of present) upsert.run(threadId, phone, phone === ownerPhone ? 1 : 0, timestamp, timestamp);
    if (!participants?.length || !present.length) return;
    const left = db.prepare(`
      DELETE FROM group_members WHERE thread_id=? AND phone NOT IN (${present.map(() => "?").join(",")}) RETURNING name
    `).all(threadId, ...present) as Array<{ name: string | null }>;
    // The roster memory says who is here, so a departure rewrites it.
    if (left.length) refreshRosterMemory(db, lifeAreaId);
  })();
}

export function groupMembers(db: Db, threadId: string): GroupMemberRow[] {
  return db.prepare("SELECT * FROM group_members WHERE thread_id=? ORDER BY is_owner DESC,rowid")
    .all(threadId) as GroupMemberRow[];
}

/**
 * The name a member goes by in this group: the one given here, else their
 * trusted-contact name. The owner is always `OWNER_SPEAKER_NAME` as a speaker,
 * whatever they told the group to call them; that name is shown beside it.
 */
function knownName(member: GroupMemberRow, contacts: Array<{ phone: string; name: string }>): string | null {
  return member.name ?? contacts.find(contact => contact.phone === member.phone)?.name ?? null;
}

/** How a member is labelled to the agent: a name, the owner, or a redacted number. */
function memberLabel(member: GroupMemberRow, contacts: Array<{ phone: string; name: string }>): string {
  if (member.is_owner) return OWNER_SPEAKER_NAME;
  return knownName(member, contacts) ?? redactedNumber(member.phone);
}

/**
 * The name a speaker's message is filed under in a group, decided when it
 * arrives. The owner is the owner; anyone else is named here if the group has
 * named them, else by their trusted-contact name, else not at all.
 */
export function speakerNameInGroup(db: Db, address: string, phone: string): string | undefined {
  const preferences = getNotificationPreferences(db);
  if (phone === preferences.recipientPhone) return OWNER_SPEAKER_NAME;
  const row = db.prepare(`
    SELECT gm.name FROM group_members gm JOIN channel_threads t ON t.id=gm.thread_id
    WHERE t.user_id=? AND t.address=? AND gm.phone=?
  `).get(USER_ID, address, phone) as { name: string | null } | undefined;
  return row?.name ?? preferences.trustedContacts.find(contact => contact.phone === phone)?.name;
}

/** One line per member, as the roster memory and the turn context describe them. */
export function rosterEntries(db: Db, threadId: string): string[] {
  const contacts = getNotificationPreferences(db).trustedContacts;
  return groupMembers(db, threadId).map(member => {
    const label = memberLabel(member, contacts);
    const ownName = member.is_owner && member.name ? ` (${member.name})` : "";
    const unnamed = !member.is_owner && !knownName(member, contacts) ? " (no name yet)" : "";
    const relationship = member.relationship ? `: ${member.relationship}` : "";
    return `${label}${ownName}${unnamed}${relationship}`;
  });
}

/** The roster as one line of turn context, or undefined before anyone is on it. */
export function rosterLine(db: Db, threadId: string): string | undefined {
  const entries = rosterEntries(db, threadId);
  return entries.length ? entries.join("; ") : undefined;
}

type Resolved = { member: GroupMemberRow; currentName: string | null };

/**
 * The member `who` names: `speaker` for whoever wrote the message being
 * answered, `the owner`, or a label from the roster — a name or a redacted
 * number such as `+1…88`. A label two members share is refused rather than
 * guessed.
 */
function resolveMember(db: Db, threadId: string, who: string, speakerPhone: string | undefined): Resolved {
  const contacts = getNotificationPreferences(db).trustedContacts;
  const members = groupMembers(db, threadId);
  const wanted = who.trim().toLowerCase();
  let matches: GroupMemberRow[];
  if (wanted === "speaker" || wanted === "me") {
    if (!speakerPhone) throw new Error("This turn has no speaker to name");
    matches = members.filter(member => member.phone === speakerPhone);
  } else if (wanted === OWNER_SPEAKER_NAME || wanted === "owner") {
    matches = members.filter(member => member.is_owner);
  } else {
    matches = members.filter(member =>
      redactedNumber(member.phone) === who.trim()
      || memberLabel(member, contacts).toLowerCase() === wanted
      || (member.name?.toLowerCase() === wanted));
  }
  if (matches.length > 1) {
    throw new Error(`More than one person here matches "${who}"; ask who they mean`);
  }
  const member = matches[0];
  if (!member) {
    throw new Error(`Nobody in this chat matches "${who}". Pass "speaker" for whoever wrote this message, or a label from groupMembers`);
  }
  return { member, currentName: member.is_owner ? member.name : knownName(member, contacts) };
}

/**
 * A name or relationship someone typed, made safe to show the agent as a
 * label: control characters and line breaks gone, and none of the brackets or
 * quotes the transcript uses to frame who said what, so "Bob] [the owner"
 * cannot forge a second speaker.
 */
function cleanPersonText(raw: string, max: number): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[[\]{}<>«»“”"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Labels the app itself gives out, which nobody in a chat may take as their name. */
const RESERVED_NAMES = new Set([OWNER_SPEAKER_NAME, "owner", "you", "me", "speaker", "assistant", ASSISTANT_NAME.toLowerCase()]);

/** Whether `name` is one of the app's own labels, or shaped like a number or a redacted number. */
function reservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase()) || /^[+\d\s().…-]+$/.test(name);
}

/** The group's roster memory, created or rewritten to match the member rows. */
function syncRosterMemory(db: Db, threadId: string, lifeAreaId: string, groupName: string): string {
  const content = [`Who's in the ${groupName} group chat:`, ...rosterEntries(db, threadId).map(entry => `- ${entry}`)].join("\n");
  const title = `Who's in ${groupName}`;
  const existing = db.prepare(`
    SELECT id FROM memories WHERE user_id=? AND life_area_id=? AND tags_json LIKE ? ORDER BY created_at LIMIT 1
  `).get(USER_ID, lifeAreaId, `%"${ROSTER_TAG}"%`) as { id: string } | undefined;
  const timestamp = now();
  if (existing) {
    const current = getMemory(db, existing.id);
    if (current && (current.content !== content || current.title !== title)) {
      db.prepare("UPDATE memories SET title=?,content=?,updated_at=? WHERE id=?").run(title, content, timestamp, existing.id);
      queueIndexJob(db, "memory", existing.id);
    }
    return existing.id;
  }
  const memoryId = id("memory");
  db.prepare(`
    INSERT INTO memories(
      id,user_id,title,content,kind,mood_label,mood_score,moods_json,category_id,life_area_id,life_area_source,
      occurred_at,review_worthy,tags_json,created_at,updated_at
    ) VALUES(?,?,?,?,'fact',NULL,NULL,NULL,NULL,?,'agent',NULL,0,?,?,?)
  `).run(memoryId, USER_ID, title, content, lifeAreaId, JSON.stringify([ROSTER_TAG]), timestamp, timestamp);
  queueIndexJob(db, "memory", memoryId);
  return memoryId;
}

/**
 * Rewrites a group's roster memory after its area was renamed, so its title
 * and heading carry the new name. Nothing is created for a group that has
 * never had anyone named.
 */
export function refreshRosterMemory(db: Db, lifeAreaId: string): void {
  const area = db.prepare("SELECT name,thread_id FROM life_areas WHERE id=? AND user_id=?")
    .get(lifeAreaId, USER_ID) as { name: string; thread_id: string | null } | undefined;
  if (!area?.thread_id) return;
  const exists = db.prepare("SELECT 1 found FROM memories WHERE user_id=? AND life_area_id=? AND tags_json LIKE ?")
    .get(USER_ID, lifeAreaId, `%"${ROSTER_TAG}"%`);
  if (exists) syncRosterMemory(db, area.thread_id, lifeAreaId, area.name);
}

/**
 * Records who someone in the group is. The owner may name anyone; anyone else
 * may only say who they are themselves, and only the owner renames someone who
 * already has a name or changes how they are related to the others. A member
 * other than the owner becomes a trusted contact under that name, and every
 * message they have written in this thread is relabelled and queued for the
 * index so recall reads them by name.
 *
 * A name is a label every later turn reads the speaker by, so the app's own
 * labels ("the owner", "you", the assistant's name, a number) and a name
 * someone else here already goes by are refused: taken, they would let one
 * person's messages read as another's.
 */
export function rememberGroupMember(
  db: Db,
  turn: { threadId: string; lifeAreaId: string; speakerIsOwner: boolean; speakerPhone?: string },
  input: { who: string; name: string; relationship?: string | null },
): Record<string, unknown> {
  const { member, currentName } = resolveMember(db, turn.threadId, input.who, turn.speakerPhone);
  if (!turn.speakerIsOwner && member.phone !== turn.speakerPhone) {
    throw new Error("Only the owner can say who someone else is; ask that person to say it themselves");
  }
  const name = cleanPersonText(input.name, 60);
  if (!name) throw new Error("That name is empty once cleaned up; ask what they want to be called");
  if (reservedName(name)) throw new Error(`"${name}" is a label the app uses itself; ask for the name they go by`);
  if (!turn.speakerIsOwner && currentName && currentName.toLowerCase() !== name.toLowerCase()) {
    throw new Error(`This person is already saved as ${currentName}; only the owner can rename them`);
  }
  const contacts = getNotificationPreferences(db).trustedContacts;
  const taken = groupMembers(db, turn.threadId).some(other =>
    other.phone !== member.phone && knownName(other, contacts)?.toLowerCase() === name.toLowerCase())
    || (!member.is_owner && contacts.some(contact => contact.phone !== member.phone && contact.name.toLowerCase() === name.toLowerCase()));
  if (taken) throw new Error(`Someone else already goes by ${name}; ask for a name that tells them apart`);
  const offered = input.relationship ? cleanPersonText(input.relationship, 120) || null : null;
  // Only the owner rewrites how someone is related to the others; a person may
  // say it of themselves while nothing is on record.
  const relationship = turn.speakerIsOwner ? offered ?? member.relationship : member.relationship ?? offered;
  const area = db.prepare("SELECT name FROM life_areas WHERE id=? AND user_id=?").get(turn.lifeAreaId, USER_ID) as { name: string } | undefined;
  return db.transaction(() => {
    const timestamp = now();
    db.prepare("UPDATE group_members SET name=?,relationship=?,updated_at=? WHERE thread_id=? AND phone=?")
      .run(name, relationship, timestamp, turn.threadId, member.phone);
    let trusted = false;
    if (!member.is_owner) {
      upsertTrustedContact(db, member.phone, name);
      trusted = true;
      // Only a new name has anything to relabel; saying it again changes no message.
      if (currentName !== name) {
        const relabelled = db.prepare(`
          UPDATE channel_messages SET metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.speakerName',?),updated_at=?
          WHERE thread_id=? AND role='user' AND json_extract(metadata_json,'$.speaker')=?
          RETURNING id
        `).all(name, timestamp, turn.threadId, member.phone) as Array<{ id: string }>;
        for (const message of relabelled) queueIndexJob(db, "channel_message", message.id);
      }
    }
    const memoryId = syncRosterMemory(db, turn.threadId, turn.lifeAreaId, area?.name ?? "group");
    return {
      name,
      relationship,
      is_owner: Boolean(member.is_owner),
      trusted_contact: trusted,
      roster: rosterEntries(db, turn.threadId),
      roster_memory_id: memoryId,
    };
  })();
}
