/**
 * What every part of the server agrees on about an iMessage group thread: how
 * its `channel_threads.address` is spelled, and what the per-message metadata a
 * group turn stores looks like. Kept apart from the Sendblue client because the
 * `group:` scheme and the speaker fields are conventions of this app's own
 * tables, read by the indexer, the tool executor, the routes, and the History
 * page's server side alike.
 */

/**
 * The prefix a group chat's thread address carries in `channel_threads`, so a
 * group and a phone number can never collide and callers can tell them apart
 * without another column. The UI keeps its own copy in
 * `src/features/history/thread-label.ts`.
 */
export const GROUP_ADDRESS_PREFIX = "group:";

export function groupAddress(groupId: string): string {
  return `${GROUP_ADDRESS_PREFIX}${groupId}`;
}

/** The Sendblue group id behind a thread address, or undefined for a 1:1 thread. */
export function groupIdOfAddress(address: string): string | undefined {
  return address.startsWith(GROUP_ADDRESS_PREFIX) ? address.slice(GROUP_ADDRESS_PREFIX.length) || undefined : undefined;
}

/**
 * The name the owner's own messages are labelled with in a group. The app has
 * no name for the owner, so this is the one word the transcript, the index, and
 * the agent all use for them; the system prompt names it too.
 */
export const OWNER_SPEAKER_NAME = "the owner";

/**
 * What the assistant is called, as the prompt introduces it. A group message
 * that says this word is addressed to it, whatever else it says.
 */
export const ASSISTANT_NAME = "Fieldnote";

/** Whether `text` names the assistant, as a word of its own rather than part of another. */
export function addressesAssistant(text: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${ASSISTANT_NAME}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/*
 * A tapback from a phone that cannot send it as a reaction arrives as plain
 * text quoting the message it was placed on: `Loved “…”` in English, `A réagi
 * avec ❤️ à « … »` in French. Each form is anchored at both ends — the verb
 * first, the quoted message last — so a sentence that merely starts with
 * "Loved" is still a message.
 */
const REACTION_TEXT = [
  // iOS quotes the message in curly quotes; `Liked "The Bear"` in straight ones is a person typing.
  /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted .{1,16} to|Removed (?:a|an) .{1,24} from)\s+“[\s\S]*”\s*\.?\s*$/u,
  // A tapback on a picture or a file has nothing to quote.
  /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted .{1,16} to) (?:an image|a photo|a video|an attachment|a movie|a sticker|an audio message)\s*\.?$/u,
  /^(?:A réagi avec .{1,16} à|A ajouté (?:un|une) « [^»]{1,32} » à|A aimé|N’aime pas|N'aime pas|A ri à propos de|A mis en évidence|A mis en doute|A retiré .{1,40} de)\s+«[\s\S]*»\s*\.?\s*$/u,
];

/** Whether `text` is a tapback that arrived as a message rather than as a reaction. */
export function isReactionText(text: string): boolean {
  const trimmed = text.trim();
  return REACTION_TEXT.some(pattern => pattern.test(trimmed));
}

/** The longest iMessage group title the app keeps; the same bound `name_group_chat` enforces. */
export const MAX_GROUP_NAME_LENGTH = 80;

/**
 * A provider-reported group title made safe to store: control characters gone,
 * whitespace collapsed, cut to the length a life area name may have. Any member
 * of the group can set the title, trusted or not, so it is data, not trusted
 * text.
 */
export function cleanGroupName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME_LENGTH).trim();
  return cleaned || undefined;
}

/** Who wrote a message in a group thread, as the row's `metadata_json` recorded it. */
export type Speaker = {
  /** The speaker's number; stays in SQLite and never goes to the index or the agent. */
  speaker?: string;
  /** The trusted-contact name, or `OWNER_SPEAKER_NAME` for the recipient. */
  speakerName?: string;
};

export function speakerOf(metadataJson: string | null | undefined): Speaker {
  if (!metadataJson) return {};
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    return {
      ...(typeof metadata.speaker === "string" && metadata.speaker ? { speaker: metadata.speaker } : {}),
      ...(typeof metadata.speakerName === "string" && metadata.speakerName ? { speakerName: metadata.speakerName } : {}),
    };
  } catch {
    return {};
  }
}

/** The name a group message was stored with, when the speaker had one. */
export function speakerNameOf(metadataJson: string | null | undefined): string | null {
  return speakerOf(metadataJson).speakerName ?? null;
}

/**
 * A phone number as it may be shown to the agent or in the archive when no name
 * is known: the country code and the last two digits, nothing that identifies
 * the line. `+17185552222` becomes `+1…22`.
 */
export function redactedNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "…";
  return `+${digits.slice(0, 1)}…${digits.slice(-2)}`;
}

/**
 * How a speaker is named in the text replayed to the agent: the name when there
 * is one, otherwise a redacted number, so that two unnamed people still read as
 * two voices and no full number leaves the server.
 */
export function speakerLabel(metadataJson: string | null | undefined): string | null {
  const { speaker, speakerName } = speakerOf(metadataJson);
  if (speakerName) return speakerName;
  if (speaker) return redactedNumber(speaker);
  return null;
}
