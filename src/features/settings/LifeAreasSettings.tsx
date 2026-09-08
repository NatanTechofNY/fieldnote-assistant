import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../api";
import { invalidateTaxonomy } from "../../lib/invalidate";
import type { LifeArea } from "../../types";

/**
 * A colour input cannot take a `var()`, and the chosen colour is stored as area
 * data rather than read back from the theme, so the default is the literal the
 * `--accent` token resolves to.
 */
const defaultAreaColor = "#5e6ad2";

export function LifeAreasSettings({ notify }: { notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const { data: areas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const [name, setName] = useState("");
  const [color, setColor] = useState(defaultAreaColor);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api.createLifeArea({ name, color }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["life-areas"] });
      notify("Classification added");
    },
    onError: (error: Error) => notify(error.message),
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => api.updateLifeArea(input.id, { name: input.name }),
    onSuccess: (area) => {
      setEditing(null);
      // The name sits on every todo and memory card of the area, not only here,
      // and a group's name is also its conversation's title.
      invalidateTaxonomy(queryClient);
      if (area.is_group) void queryClient.invalidateQueries({ queryKey: ["channel-conversations"] });
      notify("Classification renamed");
    },
    onError: (error: Error) => notify(error.message),
  });
  const remove = useMutation({
    mutationFn: api.deleteLifeArea,
    onSuccess: () => {
      invalidateTaxonomy(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["channel-conversations"] });
      notify("Classification removed; its records are now unclassified");
    },
    onError: (error: Error) => notify(error.message),
  });
  const submitRename = () => {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) return;
    rename.mutate({ id: editing.id, name: trimmed });
  };
  const subtitle = (area: LifeArea) => area.is_builtin ? "Default classification" : area.is_group ? "Group chat" : area.slug;
  // Removing a group's area is more than unfiling: the group chat can only see
  // what is filed in its area, so its earlier todos and memories go out of its
  // reach (they stay in the app for the owner) and their reminders come to the
  // owner instead of the group.
  const removePrompt = (area: LifeArea) => area.is_group
    ? `Remove ${area.name}? Its todos and memories stay in the app but become unclassified, so the group chat will no longer see them or be reminded about them; the next message there starts a fresh classification.`
    : `Remove ${area.name}? Existing records will become unclassified.`;
  return <div>
    <p className="integration-copy">Life areas classify todos and memories across the app. The Agent discovers custom areas automatically before assigning them, and gives each group chat its own.</p>
    <div className="life-area-settings-list">
      {areas.map(area => <div className="life-area-setting" key={area.id}>
        <i style={{ background: area.color }}/>
        {editing?.id === area.id
          ? <form className="life-area-rename" onSubmit={event => { event.preventDefault(); submitRename(); }}>
            <input
              className="input"
              value={editing.name}
              aria-label={`New name for ${area.name}`}
              autoFocus
              onChange={event => setEditing({ id: area.id, name: event.target.value })}
              onKeyDown={event => { if (event.key === "Escape") setEditing(null); }}
            />
            <button type="submit" className="button icon ghost" aria-label="Save name" disabled={rename.isPending || !editing.name.trim()}><Check size={13}/></button>
            <button type="button" className="button icon ghost" aria-label="Cancel rename" onClick={() => setEditing(null)}><X size={13}/></button>
          </form>
          : <div><strong>{area.name}</strong><small>{subtitle(area)}</small></div>}
        {!area.is_builtin && editing?.id !== area.id && <button className="button icon ghost" aria-label={`Rename ${area.name}`} onClick={() => setEditing({ id: area.id, name: area.name })}><Pencil size={13}/></button>}
        {!area.is_builtin && <button className="button icon ghost" aria-label={`Remove ${area.name}`} disabled={remove.isPending} onClick={() => confirm(removePrompt(area)) && remove.mutate(area.id)}><Trash2 size={13}/></button>}
      </div>)}
    </div>
    <form className="life-area-add" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <input type="color" value={color} onChange={event => setColor(event.target.value)}/>
      <input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="New classification name" required/>
      <button className="button primary" disabled={create.isPending || !name.trim()}><Plus size={14}/>Add</button>
    </form>
    <small className="field-hint">Work, Personal, and Side Project are stable defaults and cannot be deleted. Custom classifications can be renamed or removed here. A group chat's classification is created by the assistant when the group first writes in; rename it here or ask the assistant, and if it is removed while the chat is still active, the next message there creates a fresh one.</small>
  </div>;
}
