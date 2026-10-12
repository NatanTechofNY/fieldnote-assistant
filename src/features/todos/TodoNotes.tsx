import { type KeyboardEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Send, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../../api";
import type { TodoComment } from "../../types";
import { invalidateContent } from "../../lib/invalidate";
import { friendlyDate, useTimezone } from "../../lib/timezone";

const fullTime = (value: string, timezone: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

/**
 * A task's log of notes: what was said or done about it, each with the time it
 * was written. The owner and the assistant both write here, so every entry says
 * which. It sits inside the task form, so nothing here submits that form: the
 * composer is a button, and Cmd/Ctrl+Enter is the shortcut for it.
 */
export function TodoNotes({ todoId }: { todoId: string }) {
  const timezone = useTimezone();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["todos", "detail", todoId],
    queryFn: () => api.todo(todoId),
  });
  const comments: TodoComment[] = data?.comments ?? [];
  const add = useMutation({
    mutationFn: (body: string) => api.addTodoComment(todoId, body),
    onSuccess: () => { setDraft(""); invalidateContent(queryClient); },
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => api.deleteTodoComment(todoId, commentId),
    onSuccess: () => invalidateContent(queryClient),
  });
  const submit = () => {
    const body = draft.trim();
    if (body && !add.isPending) add.mutate(body);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  };
  return <div className="subtask-editor task-notes">
    <div className="subtask-editor-head">
      <span className="eyebrow">Activity</span>
      {comments.length > 0 && <span className="subtask-tally">{comments.length} {comments.length === 1 ? "note" : "notes"}</span>}
    </div>
    {isLoading && <p className="subtask-empty">Loading notes…</p>}
    {error && <div className="inline-error"><TriangleAlert size={14}/><span>{error.message}</span></div>}
    {!isLoading && !error && !comments.length && <p className="subtask-empty">No notes yet. Add what happened or what you learned; each one is saved with the time, and the assistant can add them too.</p>}
    {comments.length > 0 && <ul className="note-list" aria-label="Task notes">{comments.map(comment => <li key={comment.id} className={`note ${comment.author}`}>
      <div className="note-head">
        <span className="note-author">{comment.author === "agent" ? "Assistant" : "You"}{comment.author_name ? ` · for ${comment.author_name}` : ""}</span>
        <time dateTime={comment.created_at} title={fullTime(comment.created_at, timezone)}>{friendlyDate(comment.created_at, timezone)}</time>
        <button
          type="button"
          className="button icon ghost"
          aria-label="Delete note"
          disabled={remove.isPending}
          onClick={() => confirm("Delete this note?") && remove.mutate(comment.id)}
        ><Trash2 size={13}/></button>
      </div>
      <p className="note-body">{comment.body}</p>
    </li>)}</ul>}
    <div className="note-compose">
      <textarea
        className="input"
        aria-label="New note"
        rows={2}
        maxLength={4000}
        placeholder="Add a note (Cmd/Ctrl+Enter to post)"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="button ghost" disabled={!draft.trim() || add.isPending} onClick={submit}>
        {add.isPending ? <LoaderCircle className="spin" size={13}/> : <Send size={13}/>}Post
      </button>
    </div>
    {add.error && <div className="inline-error"><TriangleAlert size={14}/><span>{add.error.message}</span></div>}
    {remove.error && <div className="inline-error"><TriangleAlert size={14}/><span>{remove.error.message}</span></div>}
  </div>;
}
