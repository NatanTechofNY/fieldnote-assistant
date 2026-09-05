export function moodEmoji(score: number) {
  return ["", "😞", "😕", "😐", "🙂", "😄"][score] || "·";
}

/** The word a score stands for when nobody wrote a mood in their own words. */
export function defaultMoodLabel(score: number) {
  return ["", "terrible", "rough", "neutral", "good", "great"][score] || "";
}
