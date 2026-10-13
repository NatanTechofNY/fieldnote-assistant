import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** What the group finished, what is coming, and how everyone has been feeling. */
export const groupWeekReview: TemplateBuilder = (_db, scope, params) => {
  if (!scope.lifeAreaId) throw new PageError("A week in review is for a group chat. Ask from inside the group, or name it with thread_id.");
  return {
    title: params.title || `${scope.groupName ?? "The group"}: week in review`,
    audience: "shared",
    expiresInDays: 10,
    blocks: [
      { type: "todos", range: "done_week", text: "Finished this week" },
      { type: "todos", range: "week", text: "Coming up" },
      { type: "todos", range: "overdue", text: "Still open" },
      { type: "mood_chart", days: 7, text: "How everyone has been" },
    ],
  };
};
