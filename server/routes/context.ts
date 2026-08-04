import type express from "express";
import type { AlgoliaSync } from "../algolia.ts";
import type { AgentStudioSyncResult } from "../agent-studio.ts";
import type { Db } from "../types.ts";

export type SearchService = Pick<
  AlgoliaSync,
  "flushSoon" | "flush" | "reindex" | "setup" | "health" | "neuralSearchEnabled"
> & {
  searchMessages?: AlgoliaSync["searchMessages"];
  searchMemories?: AlgoliaSync["searchMemories"];
  searchAll?: AlgoliaSync["searchAll"];
};

export type AgentStudioService = { syncTools: () => Promise<AgentStudioSyncResult> };

/**
 * What an app-composed turn records about itself. History renders these as a
 * labelled block rather than as the prompt text, because the user never typed
 * any of it.
 */
export type DraftContext =
  | { kind: "reflection_generation"; label: string; selectedCount: number }
  | {
    kind: "digest_brief";
    briefId: string;
    briefName: string;
    instruction: string;
    date: string;
    preview: true;
  };

/**
 * Runs one app-composed turn through the agent and returns its text. Reflection
 * drafts, performance reviews, and digest-brief previews all need the tool loop
 * without an SMS at the end of it.
 */
export type AgentDrafter = (
  prompt: string,
  address: string,
  options?: { channel?: "web" | "sms"; context?: DraftContext },
) => Promise<string>;

/** Everything a route module needs from `createApp`'s closure. */
export interface RouteContext {
  app: express.Express;
  db: Db;
  search: SearchService;
  agentStudio: AgentStudioService;
  draftWithAgent: AgentDrafter;
}
