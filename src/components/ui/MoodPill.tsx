import { moodEmoji } from "../../lib/mood";

/**
 * A journal entry's mood as the user or the agent put it — "grateful and
 * relaxed" rather than only the emoji its score maps to. Callers that already
 * draw the emoji elsewhere pass the label alone.
 */
export function MoodPill({ score, label }: { score?: number | null; label?: string | null }) {
  if (!score && !label) return null;
  return <span className="mood-pill" title={label ? `Mood: ${label}` : undefined}>
    {score ? <span aria-hidden="true">{moodEmoji(score)}</span> : null}
    {label}
  </span>;
}
