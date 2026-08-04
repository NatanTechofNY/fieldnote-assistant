import type { QueryClient } from "@tanstack/react-query";

/**
 * Queries that read todos or memories, directly or through a rollup. A write to
 * either table can change all of them, so they refetch together.
 *
 * The point of naming them is what is *absent*: integrations, health, and
 * channel history do not move when a task is edited, and a bare
 * `invalidateQueries()` was refetching those too on every keystroke-sized save.
 */
const contentKeys = ["todos", "memories", "overview", "reflection"] as const;

export function invalidateContent(client: QueryClient): void {
  for (const key of contentKeys) void client.invalidateQueries({ queryKey: [key] });
}

/**
 * A life area or category rename rewrites the labels embedded in every todo and
 * memory projection, so the taxonomy lists have to refetch alongside content.
 */
export function invalidateTaxonomy(client: QueryClient): void {
  invalidateContent(client);
  void client.invalidateQueries({ queryKey: ["life-areas"] });
  void client.invalidateQueries({ queryKey: ["categories"] });
}
