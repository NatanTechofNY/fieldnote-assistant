import type { PersonMood } from "../types";

export function moodEmoji(score: number) {
  return ["", "😞", "😕", "😐", "🙂", "😄"][score] || "·";
}

/** The word a score stands for when nobody wrote a mood in their own words. */
export function defaultMoodLabel(score: number) {
  return ["", "terrible", "rough", "neutral", "good", "great"][score] || "";
}

/** The owner is "the owner" in the archive and "you" on their own screen. */
export function moodOwnerName(name: string): string {
  return name === "the owner" ? "you" : name;
}

/** `Sarah drained 2 · you good 4` — each person's word and number on a shared entry. */
export function describeMoods(moods: PersonMood[]): string {
  return moods.map(mood => `${moodOwnerName(mood.name)} ${mood.label} ${mood.score}`).join(" · ");
}
