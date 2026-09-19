/**
 * The editable half of each scheduled check-in.
 *
 * A check-in turn has two parts: the ask — what the agent is told to write —
 * and the context the app looked up (the date, what is open, who is in the
 * room). The owner may reword the ask per group and for their own evening;
 * the context, and the rule that the turn uses no tools and saves nothing,
 * stay the app's, so a rewording can change the tone or the questions but
 * cannot turn a check-in into a turn that writes records.
 */

/** Long enough for a paragraph of instruction; short enough that the context still fits comfortably. */
export const CHECKIN_PROMPT_MAX = 600;

/** `{group}` in a group's ask is replaced with the group's current name. */
export const GROUP_NAME_TOKEN = "{group}";

export const DEFAULT_GROUP_MORNING_ASK =
  `Write this morning's check-in for the group chat "${GROUP_NAME_TOKEN}": two or three warm sentences to the room`
  + " naming what is still going and when each is due, and asking what to wrap up today or move. No list, no headings.";

export const DEFAULT_GROUP_EVENING_ASK =
  `Ask the group chat "${GROUP_NAME_TOKEN}" how today went: one warm question to everyone in it, asking each for a line`
  + " about their day and a mood word with a number from 1 to 5. Nothing else on this turn — no summary, no list.";

export const DEFAULT_OWNER_EVENING_ASK =
  "Ask me how today went, in one warm line, asking for a mood word and a number from 1 to 5 with it. Nothing else"
  + " on this turn — no summary, no list.";

/** The defaults as the settings page shows them beside the override fields. */
export const CHECKIN_DEFAULTS = {
  groupMorning: DEFAULT_GROUP_MORNING_ASK,
  groupEvening: DEFAULT_GROUP_EVENING_ASK,
  ownerEvening: DEFAULT_OWNER_EVENING_ASK,
} as const;

/** The ask to send: the owner's wording when there is one, the default otherwise, with the group named. */
export function renderAsk(override: string | null | undefined, fallback: string, groupName?: string): string {
  const ask = override?.trim() ? override.trim() : fallback;
  return groupName === undefined ? ask : ask.split(GROUP_NAME_TOKEN).join(groupName);
}
