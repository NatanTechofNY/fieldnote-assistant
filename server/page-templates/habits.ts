import type { TemplateBuilder } from "./types.ts";

/** A streak calendar for every repeating todo. */
export const habits: TemplateBuilder = (_db, _scope, params) => ({
  title: params.title || "Habits",
  audience: "owner",
  blocks: [{ type: "habits" }],
});
