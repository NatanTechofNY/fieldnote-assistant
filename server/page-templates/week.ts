import type { TemplateBuilder } from "./types.ts";
import { groupAudience } from "./types.ts";

/** The rest of this week, what slipped, and what has been finished so far. */
export const week: TemplateBuilder = (_db, scope, params) => ({
  title: params.title || (scope.groupName ? `${scope.groupName}: this week` : "This week"),
  kind: "week",
  audience: groupAudience(scope),
  expiresInDays: 10,
  blocks: [
    { type: "todos", range: "week", text: "Coming up" },
    { type: "todos", range: "overdue", text: "Overdue" },
    { type: "todos", range: "done_week", text: "Done so far" },
  ],
});
