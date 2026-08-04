export function moodEmoji(score: number) {
  return ["", "😞", "😕", "😐", "🙂", "😄"][score] || "·";
}
