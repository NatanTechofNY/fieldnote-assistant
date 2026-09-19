/**
 * Per-person moods on a shared journal entry.
 *
 * A group's evening question gets one answer per person, and the day gets one
 * entry. Each person's mood is kept on its own — name, word, score — in
 * `memories.moods_json`, and the entry's `mood_label` and `mood_score` are
 * derived from them here: the words joined, the scores averaged and rounded.
 * The model used to do that arithmetic itself; the server doing it means a
 * later answer can arrive as just that person's mood and the rest is kept.
 */

export type PersonMood = { name: string; label: string; score: number };

/** Between one person's word and the next in the combined label. */
const LABEL_JOIN = " · ";

/** As many people as a chat could plausibly hold; the tool schema allows this many per write too. */
const PEOPLE_LIMIT = 20;

/** The plain `mood_label` column is bounded by its Zod schema; the derived one keeps to it. */
const LABEL_LIMIT = 100;

/** Names compare loosely: "Sarah" and " sarah " are the same person. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether a stored entry is a mood in the shape the app writes; anything else is dropped on read. */
function wellFormed(entry: unknown): entry is PersonMood {
  const mood = entry as PersonMood;
  return typeof entry === "object" && entry !== null
    && typeof mood.name === "string" && mood.name.trim().length > 0 && mood.name.length <= 60
    && typeof mood.label === "string" && mood.label.length <= 60
    && Number.isInteger(mood.score) && mood.score >= 1 && mood.score <= 5;
}

export function parseMoods(json: string | null | undefined): PersonMood[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(wellFormed).slice(0, PEOPLE_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The moods after `incoming` lands: each incoming person replaces their own
 * earlier mood and anyone else's stays, in the order people first answered.
 * A later answer from the same person is a correction, not a second vote, and
 * the name stays as it was first written. Past the cap, a new person is not
 * added — a chat does not gain a twenty-first member mid-evening.
 */
export function mergeMoods(existing: PersonMood[], incoming: PersonMood[]): PersonMood[] {
  const merged = existing.map(mood => ({ ...mood, name: mood.name.trim(), label: mood.label.trim() }));
  for (const mood of incoming) {
    const next = { name: mood.name.trim(), label: mood.label.trim(), score: mood.score };
    const index = merged.findIndex(entry => sameName(entry.name, next.name));
    if (index !== -1) merged[index] = { ...next, name: merged[index].name };
    else if (merged.length < PEOPLE_LIMIT) merged.push(next);
  }
  return merged;
}

/**
 * The entry's combined mood: every person's word, and the average score
 * rounded to a whole number since the column is 1–5. Two and four make three;
 * two and five make four. An empty list clears both. A label too long for the
 * column is cut between people, never through a name, and says how many more.
 */
export function combineMoods(moods: PersonMood[]): { mood_label: string | null; mood_score: number | null } {
  if (!moods.length) return { mood_label: null, mood_score: null };
  const words = moods.map(mood => `${mood.name} ${mood.label}`);
  let label = words.join(LABEL_JOIN);
  for (let shown = words.length - 1; label.length > LABEL_LIMIT && shown > 0; shown -= 1) {
    label = `${words.slice(0, shown).join(LABEL_JOIN)} (+${words.length - shown} more)`;
  }
  const score = Math.round(moods.reduce((sum, mood) => sum + mood.score, 0) / moods.length);
  return { mood_label: label.slice(0, LABEL_LIMIT), mood_score: Math.min(5, Math.max(1, score)) };
}

/** A mood as a tool or the REST API may send it: the name may be left to the turn's speaker. */
export type IncomingMood = { name?: string | null; label: string; score: number };

/**
 * What a write leaves in the three mood columns.
 *
 * With `moods` in the write, each incoming person replaces their own earlier
 * mood, the rest stay, and the label and score are derived — whatever plain
 * `mood_label`/`mood_score` the write also carried. Names: an unnamed mood is
 * the speaker's, and when the speaker is not the owner (`ownMoodOnly`), every
 * incoming mood is the speaker's whatever name it came with — nobody in a
 * group records another person's evening, and nobody but the owner records
 * the owner's. A write with no speaker to attribute to is refused rather than
 * guessed. Clearing `moods` empties the list and falls back to the plain
 * fields. Without `moods`, an entry that already has a list keeps it and the
 * derived fields — a plain score cannot contradict the people underneath it —
 * and an entry without one takes the write's plain fields, as before.
 */
export function resolveMoodFields(input: {
  existingJson: string | null | undefined;
  incoming: IncomingMood[] | null | undefined;
  clear: boolean;
  plain: { mood_label: string | null; mood_score: number | null };
  /** Who is writing, as the app names them; undefined when nobody is known. */
  speakerName: string | null | undefined;
  /** The speaker may record only their own mood: a group participant who is not the owner. */
  ownMoodOnly?: boolean;
}): { moods_json: string | null; mood_label: string | null; mood_score: number | null } {
  if (input.clear) return { moods_json: null, ...input.plain };
  const existing = parseMoods(input.existingJson);
  if (!input.incoming) {
    if (!existing.length) return { moods_json: input.existingJson ?? null, ...input.plain };
    return { moods_json: input.existingJson ?? null, ...combineMoods(existing) };
  }
  const speaker = input.speakerName?.trim() || null;
  const named = input.incoming.map(mood => {
    const name = input.ownMoodOnly ? speaker : (mood.name?.trim() || speaker);
    if (!name) throw new Error("A mood needs a name: say whose it is");
    return { name, label: mood.label, score: mood.score };
  });
  const merged = mergeMoods(existing, named);
  return { moods_json: merged.length ? JSON.stringify(merged) : null, ...combineMoods(merged) };
}
