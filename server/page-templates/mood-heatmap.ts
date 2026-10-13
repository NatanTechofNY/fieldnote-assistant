import type { TemplateBuilder } from "./types.ts";

/** Daily mood for the last three months, with the recent trend above it. */
export const moodHeatmap: TemplateBuilder = (_db, _scope, params) => ({
  title: params.title || "Mood",
  audience: "owner",
  blocks: [
    { type: "mood_chart", days: 30, text: "Last 30 days" },
    { type: "mood_heatmap", days: 90, text: "Last 3 months" },
  ],
});
