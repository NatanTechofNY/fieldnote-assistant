import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import { invalidateTaxonomy } from "../../lib/invalidate";

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
  const create = useMutation({
    mutationFn: () => api.createLifeArea({ name, color }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["life-areas"] });
      notify("Classification added");
    },
    onError: (error: Error) => notify(error.message),
  });
  const remove = useMutation({
    mutationFn: api.deleteLifeArea,
    onSuccess: () => {
      invalidateTaxonomy(queryClient);
      notify("Classification removed; its records are now unclassified");
    },
    onError: (error: Error) => notify(error.message),
  });
  return <div>
    <p className="integration-copy">Life areas classify todos and memories across the app. The Agent discovers custom areas automatically before assigning them.</p>
    <div className="life-area-settings-list">
      {areas.map(area => <div className="life-area-setting" key={area.id}>
        <i style={{ background: area.color }}/>
        <div><strong>{area.name}</strong><small>{area.is_builtin ? "Default classification" : area.slug}</small></div>
        {!area.is_builtin && <button className="button icon ghost" aria-label={`Remove ${area.name}`} disabled={remove.isPending} onClick={() => confirm(`Remove ${area.name}? Existing records will become unclassified.`) && remove.mutate(area.id)}><Trash2 size={13}/></button>}
      </div>)}
    </div>
    <form className="life-area-add" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <input type="color" value={color} onChange={event => setColor(event.target.value)}/>
      <input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="New classification name" required/>
      <button className="button primary" disabled={create.isPending || !name.trim()}><Plus size={14}/>Add</button>
    </form>
    <small className="field-hint">Work, Personal, and Side Project are stable defaults and cannot be deleted. Custom classifications can be removed here.</small>
  </div>;
}
