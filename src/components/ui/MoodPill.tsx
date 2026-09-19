import { moodEmoji, moodOwnerName } from "../../lib/mood";
import type { PersonMood } from "../../types";

/**
 * A journal entry's mood as the user or the agent put it — "grateful and
 * relaxed" rather than only the emoji its score maps to. Callers that already
 * draw the emoji elsewhere pass the label alone.
 *
 * A shared entry carries one mood per person; those show as a chip each — the
 * owner as "you" — instead of the combined label, so a 2 and a 4 stay a 2 and
 * a 4 rather than a "3".
 */
export function MoodPill({ score, label, moods }: { score?: number | null; label?: string | null; moods?: PersonMood[] }) {
  if (moods?.length) {
    return <span className="mood-pills">
      {moods.map(mood => {
        const who = moodOwnerName(mood.name);
        return <span className="mood-pill" key={mood.name} title={`${who}: ${mood.label}, ${mood.score} of 5`}>
          <span aria-hidden="true">{moodEmoji(mood.score)}</span>
          <strong>{who}</strong> {mood.label}
        </span>;
      })}
    </span>;
  }
  if (!score && !label) return null;
  return <span className="mood-pill" title={label ? `Mood: ${label}` : undefined}>
    {score ? <span aria-hidden="true">{moodEmoji(score)}</span> : null}
    {label}
  </span>;
}
