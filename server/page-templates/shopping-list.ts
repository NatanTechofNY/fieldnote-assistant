import { getTodo } from "../db.ts";
import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/**
 * A group's list that anyone with the link can tick off: groceries, packing,
 * what to bring. The page service writes it as a parent todo in the group's own
 * area with one subtask per item, so it is also on the board and in search;
 * `todo_id` adds the items to a list that already exists.
 */
export const shoppingList: TemplateBuilder = (db, scope, params) => {
  if (!scope.lifeAreaId) {
    throw new PageError("A shared shopping list belongs to a group chat. Ask from inside the group, or name it with thread_id.");
  }
  let title = params.title || "Shopping list";
  if (params.todo_id) {
    const parent = getTodo(db, params.todo_id);
    if (!parent || parent.life_area_id !== scope.lifeAreaId) throw new PageError("That list is not one of this group's");
    title = params.title || parent.title;
  } else if (!params.items?.length) {
    throw new PageError("shopping_list needs the items to tick off");
  }
  return {
    title,
    audience: "shared",
    blocks: [{ type: "live_checklist", text: title, todo_id: params.todo_id ?? undefined, items: params.items ?? undefined }],
  };
};
