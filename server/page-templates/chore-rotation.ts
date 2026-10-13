import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** People in `items`, the chore as `title`, `when` for the week the rotation starts, `todo_id` for a repeating todo whose streak to show. */
export const choreRotation: TemplateBuilder = (_db, _scope, params) => {
  if ((params.items?.length ?? 0) < 2) throw new PageError("chore_rotation needs at least two names in items");
  const chore = params.title || "Chore rotation";
  return {
    title: chore,
    audience: "shared",
    blocks: [{
      type: "rotation",
      text: chore,
      items: params.items as string[],
      ...(params.when ? { when: params.when } : {}),
      ...(params.todo_id ? { todo_id: params.todo_id } : {}),
    }],
  };
};
