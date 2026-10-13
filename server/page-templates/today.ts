import type { TemplateBuilder } from "./types.ts";
import { groupAudience } from "./types.ts";

/** Today's open todos and anything left over from earlier days, read live each time the page opens. */
export const today: TemplateBuilder = (_db, scope, params) => ({
  title: params.title || (scope.groupName ? `${scope.groupName}: today` : "Today"),
  kind: "today",
  audience: groupAudience(scope),
  expiresInDays: 2,
  blocks: [
    { type: "todos", range: "today", text: "Due today" },
    { type: "todos", range: "overdue", text: "Still open from earlier" },
  ],
});
