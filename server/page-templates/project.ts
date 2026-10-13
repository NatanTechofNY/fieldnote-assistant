import { getTodo } from "../db.ts";
import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** A parent todo (`todo_id`) with progress across its subtasks and its notes. */
export const project: TemplateBuilder = (db, _scope, params) => {
  const parent = params.todo_id ? getTodo(db, params.todo_id) : undefined;
  if (!parent) throw new PageError("project needs todo_id, the parent todo whose subtasks make up the project");
  return {
    title: params.title || parent.title,
    audience: "owner",
    blocks: [{ type: "progress", todo_id: parent.id, text: parent.title }],
  };
};
