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

/** Names compare loosely: "Sarah" and " sarah " are the same person. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function parseMoods(json: string | null | undefined): PersonMood[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PersonMood =>
      typeof entry === "object" && entry !== null
      && typeof (entry as PersonMood).name === "string"
      && typeof (entry as PersonMood).label === "string"
      && typeof (entry as PersonMood).score === "number");
  } catch {
    return [];
  }
}

/**
 * The moods after `incoming` lands: each incoming person replaces their own
 * earlier mood and anyone else's stays, in the order people first answered.
 * A later answer from the same person is a correction, not a second vote.
 */
export function mergeMoods(existing: PersonMood[], incoming: PersonMood[]): PersonMood[] {
  const merged = existing.map(mood => ({ ...mood, name: mood.name.trim(), label: mood.label.trim() }));
  for (const mood of incoming) {
    const next = { name: mood.name.trim(), label: mood.label.trim(), score: mood.score };
    const index = merged.findIndex(entry => sameName(entry.name, next.name));
    // The name stays as it was first written; a correction changes the mood, not the spelling.
    if (index === -1) merged.push(next);
    else merged[index] = { ...next, name: merged[index].name };
  }
  return merged;
}

/**
 * The entry's combined mood: every person's word, and the average score
 * rounded to a whole number since the column is 1–5. Two and four make three;
 * two and five make four. An empty list clears both.
 */
export function combineMoods(moods: PersonMood[]): { mood_label: string | null; mood_score: number | null } {
  if (!moods.length) return { mood_label: null, mood_score: null };
  const label = moods.map(mood => `${mood.name} ${mood.label}`).join(LABEL_JOIN);
  const score = Math.round(moods.reduce((sum, mood) => sum + mood.score, 0) / moods.length);
  return { mood_label: label.slice(0, 100), mood_score: Math.min(5, Math.max(1, score)) };
}

/** A mood as a tool or the REST API may send it: the name may be left to the turn's speaker. */
export type IncomingMood = { name?: string | null; label: string; score: number };

/**
 * What a write leaves in the three mood columns.
 *
 * With `moods` in the write, each incoming person (named, or the speaker when
 * the name is left out) replaces their own earlier mood, the rest stay, and the
 * label and score are derived — whatever `mood_label`/`mood_score` the write
 * also carried. Clearing `moods` empties the list and falls back to the plain
 * fields. Without `moods`, the list is untouched and the plain fields are the
 * write's own, as before: an entry with one mood never needs the list.
 */
export function resolveMoodFields(input: {
  existingJson: string | null | undefined;
  incoming: IncomingMood[] | null | undefined;
  clear: boolean;
  plain: { mood_label: string | null; mood_score: number | null };
  speakerName: string | null | undefined;
}): { moods_json: string | null; mood_label: string | null; mood_score: number | null } {
  if (input.clear) return { moods_json: null, ...input.plain };
  if (!input.incoming) {
    return { moods_json: input.existingJson ?? null, ...input.plain };
  }
  const named = input.incoming.map(mood => ({
    name: mood.name?.trim() || input.speakerName?.trim() || "the owner",
    label: mood.label,
    score: mood.score,
  }));
  const merged = mergeMoods(parseMoods(input.existingJson), named);
  return { moods_json: merged.length ? JSON.stringify(merged) : null, ...combineMoods(merged) };
}
