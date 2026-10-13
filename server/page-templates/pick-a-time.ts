import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** Days in `items` (such as "Thu Oct 15"), times in `slots` (such as "6pm"), an optional `closes_at`. */
export const pickATime: TemplateBuilder = (_db, _scope, params) => {
  if (!params.items?.length) throw new PageError("pick_a_time needs the days to offer in items, such as \"Thu Oct 15\"");
  return {
    title: params.title || "Pick a time",
    audience: "shared",
    blocks: [{
      type: "availability",
      text: params.title || "When can you make it?",
      items: params.items,
      ...(params.slots?.length ? { slots: params.slots } : {}),
      ...(params.closes_at ? { closes_at: params.closes_at } : {}),
    }],
  };
};
