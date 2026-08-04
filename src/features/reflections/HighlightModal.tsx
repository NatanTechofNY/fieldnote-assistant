import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Award, LoaderCircle, TriangleAlert } from "lucide-react";
import { api } from "../../api";
import type {
  LifeArea,
} from "../../types";
import { Field, Modal } from "../../components/ui";
import { toZonedDateTimeLocal, useTimezone, zonedDateTimeLocalToIso } from "../../lib/timezone";

export function HighlightModal({ lifeAreas, initialLifeAreaId, onClose, onSaved }: { lifeAreas: LifeArea[]; initialLifeAreaId: string; onClose: () => void; onSaved: () => void }) {
  const timezone = useTimezone();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [lifeAreaId, setLifeAreaId] = useState(initialLifeAreaId);
  const [occurredAt, setOccurredAt] = useState(toZonedDateTimeLocal(new Date().toISOString(), timezone));
  const save = useMutation({
    mutationFn: () => api.createMemory({
      kind: "note",
      title,
      content,
      tags: ["highlight"],
      life_area_id: lifeAreaId || undefined,
      life_area_source: lifeAreaId ? "user" : undefined,
      occurred_at: zonedDateTimeLocalToIso(occurredAt, timezone),
      review_worthy: true,
    }),
    onSuccess: onSaved,
  });
  return <Modal title="Log a highlight" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <p className="modal-intro">Capture a moment worth remembering while its context is fresh.</p>
      <Field label="What happened?"><input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="Shipped the new onboarding flow" required autoFocus/></Field>
      <Field label="Context"><textarea className="textarea" value={content} onChange={event => setContent(event.target.value)} placeholder="What made this meaningful? Keep the details you will want later." required/></Field>
      <Field label="Life area"><select className="select" value={lifeAreaId} onChange={event => setLifeAreaId(event.target.value)}><option value="">Unclassified</option>{lifeAreas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field>
      <Field label={`When · ${timezone}`}><input type="datetime-local" className="input" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} required/></Field>
      {save.error && <div className="inline-error"><TriangleAlert size={14}/><span>{save.error.message}</span></div>}
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={14}/> : <Award size={14}/>}Save highlight</button></div>
    </form>
  </Modal>;
}
