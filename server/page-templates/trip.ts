import { PageError } from "../pages.ts";
import type { PageBlock } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** The plan in `items` ("Fri 7pm | Dinner"), the start in `when`, the packing list in `slots`. */
export const trip: TemplateBuilder = (_db, _scope, params) => {
  if (!params.items?.length && !params.when) throw new PageError("trip needs an itinerary in items or a start in when");
  const title = params.title || "Trip";
  const blocks: PageBlock[] = [];
  if (params.when) blocks.push({ type: "countdown", text: title, when: params.when });
  if (params.items?.length) blocks.push({ type: "itinerary", text: "Plan", items: params.items });
  if (params.slots?.length) {
    blocks.push({ type: "heading", text: "Packing" });
    blocks.push({ type: "checklist", items: params.slots });
  }
  return { title, audience: "shared", blocks };
};
