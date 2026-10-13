import { id, now, queueIndexJob, USER_ID } from "../db.ts";
import { getTodo } from "../db.ts";
import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/**
 * A group's list that anyone with the link can tick off. The list is a parent
 * todo in the group's own area with one subtask per item, so it is also on the
 * board and in search; `todo_id` adds the items to a list that already exists.
 */
export const shoppingList: TemplateBuilder = (db, scope, params) => {
  if (!scope.lifeAreaId) {
    throw new PageError("A shared shopping list belongs to a group chat. Ask from inside the group, or name it with thread_id.");
  }
  let parentId = params.todo_id ?? null;
  const timestamp = now();
  const insert = db.prepare(`
    INSERT INTO todos(id,user_id,title,life_area_id,life_area_source,parent_id,status,reply_thread_id,created_at,updated_at)
    VALUES(?,?,?,?,'agent',?,'pending',?,?,?)
  `);
  let title = params.title || "Shopping list";
  db.transaction(() => {
    if (parentId) {
      const parent = getTodo(db, parentId);
      if (!parent || parent.life_area_id !== scope.lifeAreaId) throw new PageError("That list is not one of this group's");
      title = params.title || parent.title;
    } else {
      parentId = id("todo");
      insert.run(parentId, USER_ID, title, scope.lifeAreaId, null, scope.threadId, timestamp, timestamp);
      queueIndexJob(db, "todo", parentId);
    }
    for (const item of params.items ?? []) {
      const itemId = id("todo");
      insert.run(itemId, USER_ID, item, scope.lifeAreaId, parentId, scope.threadId, timestamp, timestamp);
      queueIndexJob(db, "todo", itemId);
    }
  })();
  return {
    title,
    audience: "shared",
    wroteTodos: true,
    blocks: [{ type: "live_checklist", todo_id: parentId as string, text: title }],
  };
};
