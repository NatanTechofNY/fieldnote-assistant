import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import type {
  LifeArea, Memory, MemoryKind,
} from "../../types";
import { Field, MarkdownEditor, Modal } from "../../components/ui";
import { moodEmoji } from "../../lib/mood";
import { toZonedDateTimeLocal, useTimezone, zonedDateTimeLocalToIso } from "../../lib/timezone";
import { invalidateContent } from "../../lib/invalidate";

export function MemoryModal({ memory, defaultKind, lifeAreas, onClose }: { memory?: Memory; defaultKind: MemoryKind; lifeAreas: LifeArea[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const timezone = useTimezone();
  const [kind, setKind] = useState<MemoryKind>(memory?.kind || defaultKind);
  const [title, setTitle] = useState(memory?.title || "");
  const [content, setContent] = useState(memory?.content || "");
  const [tags, setTags] = useState(memory?.tags.join(", ") || "");
  const [mood, setMood] = useState(memory?.mood_score || 3);
  const [lifeAreaId, setLifeAreaId] = useState(memory?.life_area_id || "");
  const [occurredAt, setOccurredAt] = useState(toZonedDateTimeLocal(memory?.occurred_at, timezone));
  const [reviewWorthy, setReviewWorthy] = useState(Boolean(memory?.review_worthy));
  const save = useMutation({
    mutationFn: () => {
      const input = {
        kind,
        title: title || null,
        content,
        tags: tags.split(",").map(t => t.trim()).filter(Boolean),
        mood_score: kind === "journal" ? mood : null,
        mood_label: kind === "journal" ? ["", "terrible", "rough", "neutral", "good", "great"][mood] : null,
        life_area_id: lifeAreaId || null,
        life_area_source: lifeAreaId ? "user" as const : null,
        occurred_at: occurredAt ? zonedDateTimeLocalToIso(occurredAt, timezone) : null,
        review_worthy: reviewWorthy,
      };
      return memory ? api.updateMemory(memory.id, input) : api.createMemory(input);
    },
    onSuccess: () => { invalidateContent(queryClient); onClose(); },
  });
  return <Modal title={memory ? "Edit memory" : "Make it memorable"} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); save.mutate(); }}>
      <Field label="Kind"><select className="select" value={kind} onChange={e => setKind(e.target.value as MemoryKind)}><option value="fact">Fact</option><option value="note">Note</option><option value="journal">Journal</option></select></Field>
      <Field label="Title"><input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Optional, but useful" /></Field>
      <Field label="What should I remember?"><MarkdownEditor value={content} onChange={setContent} required autoFocus /></Field>
      <div className="form-grid">
        <Field label="Life area"><select className="select" value={lifeAreaId} onChange={e => setLifeAreaId(e.target.value)}><option value="">Unclassified</option>{lifeAreas.map(area => <option value={area.id} key={area.id}>{area.name}</option>)}</select></Field>
        <Field label={`Occurred · ${timezone}`}><input type="datetime-local" className="input" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></Field>
      </div>
      <label className="toggle-row"><input type="checkbox" checked={reviewWorthy} onChange={e => setReviewWorthy(e.target.checked)}/><span>Highlight this for future reflections</span></label>
      <Field label="Tags"><input className="input" value={tags} onChange={e => setTags(e.target.value)} placeholder="work, idea, family" /></Field>
      {kind === "journal" && <Field label="Mood"><div style={{ display: "flex", justifyContent: "space-between" }}>{[1,2,3,4,5].map(score => <button type="button" key={score} className={`button icon ${mood === score ? "dark" : "ghost"}`} onClick={() => setMood(score)} style={{ fontSize: 20 }}>{moodEmoji(score)}</button>)}</div></Field>}
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={save.isPending}>Save memory</button></div>
    </form>
  </Modal>;
}
