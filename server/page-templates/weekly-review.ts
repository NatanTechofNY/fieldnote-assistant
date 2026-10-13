import type { TemplateBuilder } from "./types.ts";

/** The owner's week: wins, what slipped, mood, and habits. Never for a group. */
export const weeklyReview: TemplateBuilder = (_db, _scope, params) => ({
  title: params.title || "Weekly review",
  audience: "owner",
  expiresInDays: 14,
  blocks: [
    { type: "todos", range: "done_week", text: "Wins" },
    { type: "todos", range: "overdue", text: "What slipped" },
    { type: "todos", range: "week", text: "Still ahead this week" },
    { type: "mood_chart", days: 7, text: "Mood this week" },
    { type: "habits" },
  ],
});
