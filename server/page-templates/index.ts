import type { PAGE_TEMPLATES } from "../schemas.ts";
import { choreRotation } from "./chore-rotation.ts";
import { groupWeekReview } from "./group-week-review.ts";
import { habits } from "./habits.ts";
import { jiraStatus } from "./jira-status.ts";
import { meetingPrep } from "./meeting-prep.ts";
import { moodHeatmap } from "./mood-heatmap.ts";
import { pickATime } from "./pick-a-time.ts";
import { project } from "./project.ts";
import { shoppingList } from "./shopping-list.ts";
import { today } from "./today.ts";
import { trip } from "./trip.ts";
import type { TemplateBuilder } from "./types.ts";
import { week } from "./week.ts";
import { weeklyReview } from "./weekly-review.ts";

export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export const templates: Record<PageTemplate, TemplateBuilder> = {
  today,
  week,
  pick_a_time: pickATime,
  shopping_list: shoppingList,
  group_week_review: groupWeekReview,
  chore_rotation: choreRotation,
  trip,
  weekly_review: weeklyReview,
  project,
  meeting_prep: meetingPrep,
  jira_status: jiraStatus,
  habits,
  mood_heatmap: moodHeatmap,
};

/** Templates that read the owner's working life or private records, so a group turn may not use them. */
export const OWNER_ONLY_TEMPLATES = new Set<PageTemplate>([
  "weekly_review", "project", "meeting_prep", "jira_status", "habits", "mood_heatmap",
]);

export type { TemplateParams, TemplateResult, TemplateScope } from "./types.ts";
