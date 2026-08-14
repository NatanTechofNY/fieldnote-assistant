import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, ChevronDown, Database, LoaderCircle, RefreshCw, Search, Settings2, Trash2, TriangleAlert, Zap } from "lucide-react";
import { api } from "../../api";
import { ErrorState, Field, HealthCard, Loading, Modal } from "../../components/ui";
import { useRedact } from "../../lib/demo-mode";
import { SettingsSection } from "./SettingsSection";

export function UnderHoodSettings({ notify }: { notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const redact = useRedact();
  const { data: health, isLoading, error } = useQuery({ queryKey: ["health"], queryFn: api.health });
  const [dangerAction, setDangerAction] = useState<"seed" | "reset" | null>(null);
  type SetupAction = "seed" | "reset" | "reindex" | "setup" | "tools";
  const action = useMutation<unknown, Error, { name: SetupAction }>({
    mutationFn: ({ name }) => {
      if (name === "seed") return api.seed("SEED");
      if (name === "reset") return api.reset("RESET");
      if (name === "reindex") return api.reindex();
      if (name === "tools") return api.syncAgentStudioTools();
      return api.setupAlgolia();
    },
    onSuccess: (_, { name }) => {
      setDangerAction(null);
      notify(name === "tools" ? "Agent instructions and tools synced" : `${name[0].toUpperCase()}${name.slice(1)} complete`);
      void queryClient.invalidateQueries();
    },
    onError: (mutationError) => notify(mutationError.message),
  });
  // One mutation backs every action here, so the spinner has to follow the
  // button that started it rather than appearing on the whole row at once.
  const running = action.isPending ? action.variables.name : null;
  return <SettingsSection
    sectionId="under-the-hood"
    title="Under the hood"
    description="Inspect system health, search indices, synchronization, and demo controls."
    status={health ? `${health.pendingIndexJobs} pending jobs` : undefined}
    icon={Activity}
  >
    {isLoading ? <Loading/> : error || !health ? <ErrorState error={error}/> : <>
      <section className="health-grid">
        <HealthCard title="SQLite" ok={health.sqlite.ok} icon={Database} detail={`${health.sqlite.records ?? 0} authoritative records`} />
        <HealthCard title={health.neuralSearch.enabled ? "Algolia NeuralSearch" : "Algolia keyword search"} ok={health.algolia.ok} icon={Search} detail={health.algolia.configured ? `${health.algolia.todoRecords ?? 0} todos · ${health.algolia.memoryRecords ?? 0} memories` : health.algolia.error || "Credentials not configured"} />
        <HealthCard title="Agent Studio" ok={health.agentStudio.configured} icon={Bot} detail={health.agentStudio.configured ? `Agent ${redact.text(health.agentStudio.agentId, 18)}` : "Add your published agent ID"} />
      </section>
      {/* One panel holds the search mode and the actions that apply it, rather
          than stacking a toggle, a callout, and a button row in three boxes. */}
      <section className="settings-panel">
        <header>
          <div>
            <div className="eyebrow">Search mode</div>
            <NeuralSearchToggle enabled={health.neuralSearch.enabled} notify={notify}/>
          </div>
          <div className="settings-panel-actions">
            <button className="button ghost" aria-busy={running === "reindex"} disabled={action.isPending} onClick={() => action.mutate({ name: "reindex" })}>
              {running === "reindex" ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}Reindex
            </button>
            <button className="button ghost" aria-busy={running === "tools"} disabled={action.isPending || !health.agentStudio.configured} onClick={() => confirm("Sync the checked-in instructions and client tools to Agent Studio? Existing Search tools will be preserved.") && action.mutate({ name: "tools" })}>
              {running === "tools" ? <LoaderCircle className="spin" size={14}/> : <Zap size={14}/>}Sync Agent config
            </button>
            <button
              className="button primary"
              aria-busy={running === "setup"}
              disabled={action.isPending}
              title="Non-destructive: applies searchable attributes, filters, ranking, and the search mode without deleting SQLite or indexed records."
              onClick={() => action.mutate({ name: "setup" })}
            >
              {running === "setup" ? <LoaderCircle className="spin" size={14}/> : <Settings2 size={14}/>}Configure Algolia
            </button>
          </div>
        </header>
        <span className="field-hint">
          Reindex rebuilds Algolia from SQLite. Configure Algolia reapplies index settings and is non-destructive.
        </span>
        <div className="config-chips">
          <span><i>Todos</i>{health.indices.todos}</span>
          <span><i>Memories</i>{health.indices.memories}</span>
          <span><i>Conversations</i>{health.indices.messages}</span>
          <span><i>Pending jobs</i>{health.pendingIndexJobs}</span>
        </div>
      </section>
      <details className="settings-explainer">
        <summary><span><Activity size={13}/>The consistency contract</span><ChevronDown size={14}/></summary>
        <div className="list">
          {["Commit the record and outbox job together.", "Sync a searchable copy to Algolia.", "Keep failed jobs durable for retry.", "Rebuild search from SQLite at any time."].map((line, index) => <div className="list-row" key={line}><span className="badge">0{index + 1}</span><div className="list-main"><strong>{line}</strong></div></div>)}
        </div>
      </details>
      <details className="danger-zone">
        <summary><span><TriangleAlert size={14}/>Danger zone</span><ChevronDown size={14}/></summary>
        <div>
          <p>These actions permanently remove assistant content from SQLite. Provider connections and notification settings are kept.</p>
          <button className="button danger" disabled={action.isPending} onClick={() => setDangerAction("seed")}>Replace with demo data</button>
          <button className="button danger" disabled={action.isPending} onClick={() => setDangerAction("reset")}><Trash2 size={14}/>Delete all assistant data</button>
        </div>
      </details>
      {dangerAction && <DestructiveDataModal
        action={dangerAction}
        pending={action.isPending}
        onClose={() => setDangerAction(null)}
        onConfirm={() => action.mutate({ name: dangerAction })}
      />}
    </>}
  </SettingsSection>;
}

/**
 * NeuralSearch is a paid Algolia add-on. Applications without it fall back to
 * keyword search, which is why this defaults off and reports when Algolia
 * refuses the mode rather than leaving setup in a failed state.
 */
function NeuralSearchToggle({ enabled, notify }: { enabled: boolean; notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setNeuralSearch(next),
    onSuccess: (result) => {
      const { neuralSearch, error } = result.setup.details ?? {};
      notify(
        neuralSearch === "unavailable_for_plan"
          ? "This Algolia application is not entitled to NeuralSearch; the indices stayed on keyword search."
          : error
            ? `Saved, but Algolia could not be reached to apply it: ${error}`
            : `Search mode set to ${result.enabled ? "NeuralSearch" : "keyword search"}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["health"] });
    },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  return <>
    <label className="toggle-row compact">
      <input
        type="checkbox"
        checked={enabled}
        disabled={toggle.isPending}
        onChange={event => toggle.mutate(event.target.checked)}
      />
      <span>Use Algolia NeuralSearch</span>
      {toggle.isPending && <LoaderCircle className="spin" size={13}/>}
    </label>
    <span className="field-hint">
      A paid add-on. Off runs the demo on keyword search; on reapplies index settings immediately.
    </span>
  </>;
}

function DestructiveDataModal({
  action,
  pending,
  onClose,
  onConfirm,
}: {
  action: "seed" | "reset";
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmation = action === "seed" ? "SEED" : "RESET";
  const [typed, setTyped] = useState("");
  return <Modal title={action === "seed" ? "Replace everything with demo data?" : "Delete all assistant data?"} onClose={onClose}>
    <div className="destructive-modal">
      <div className="destructive-warning"><TriangleAlert size={17}/><strong>This cannot be undone.</strong></div>
      <p>{action === "seed"
        ? "This deletes your todos, memories, reminders, conversations, categories, and search jobs before inserting a small sample dataset."
        : "This deletes your todos, memories, reminders, conversations, categories, and search jobs without adding replacements."}</p>
      <p>Twilio and Granola credentials, delivery preferences, and life-area definitions are not deleted.</p>
      <Field label={`Type ${confirmation} to continue`}><input className="input" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" autoFocus/></Field>
      <div className="modal-actions">
        <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="button danger" disabled={typed !== confirmation || pending} onClick={onConfirm}>
          {pending ? <LoaderCircle className="spin" size={14}/> : <Trash2 size={14}/>}
          {action === "seed" ? "Delete and seed" : "Delete everything"}
        </button>
      </div>
    </div>
  </Modal>;
}
