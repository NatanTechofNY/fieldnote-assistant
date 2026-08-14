import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookText, Check, ListChecks, LoaderCircle, MessageSquareText, Moon, Play, Plus, Sparkles,
  SquareKanban, Trash2, TriangleAlert, X, Zap,
} from "lucide-react";
import { api } from "../../api";
import type { DigestBrief, DigestBriefResource, IntegrationState } from "../../types";
import { Field } from "../../components/ui";
import { useRedact } from "../../lib/demo-mode";
import { humanTime, withinQuietHours } from "../../lib/timezone";

export function AtlassianSettings({
  config,
  secretStorageReady,
  notify,
  refresh,
}: {
  config: IntegrationState["atlassian"];
  secretStorageReady: boolean;
  notify: (message: string) => void;
  refresh: () => void;
}) {
  const redact = useRedact();
  const [siteUrl, setSiteUrl] = useState(config.siteUrl || "");
  const [email, setEmail] = useState(config.email || "");
  const [apiToken, setApiToken] = useState("");
  const connect = useMutation({
    mutationFn: () => api.connectAtlassian({ siteUrl, email, apiToken }),
    onSuccess: (result) => {
      setApiToken("");
      refresh();
      notify(result.config.jiraAvailable && result.config.confluenceAvailable
        ? "Atlassian connected for Jira and Confluence"
        : `Atlassian connected for ${result.config.jiraAvailable ? "Jira" : "Confluence"} only`);
    },
    onError: (error: Error) => notify(error.message),
  });
  return <div>
    <p className="integration-copy">
      Read-only access to Jira boards and issues and to Confluence spaces, pages, and comments. Nothing here can
      comment, transition an issue, or edit a page.
    </p>
    <div className="integration-status">
      <span className={`dot ${config.configured ? "ok" : ""}`}/>
      {config.configured ? `Connected · ${redact.text(config.displayName || config.email, 12)}` : "Not connected"}
    </div>
    {config.configured && <div className="atlassian-products">
      {/* Licensed separately, so a token can be perfectly valid for one and not the other. */}
      <span className={`badge ${config.jiraAvailable ? "ok" : ""}`}><SquareKanban size={11}/>Jira {config.jiraAvailable ? "available" : "no access"}</span>
      <span className={`badge ${config.confluenceAvailable ? "ok" : ""}`}><BookText size={11}/>Confluence {config.confluenceAvailable ? "available" : "no access"}</span>
    </div>}
    <div className="form-grid">
      <Field
        label="Site URL"
        hint="A classic API token authenticates against this host. Scoped tokens work only against api.atlassian.com."
      >
        <input className="input" type={redact.inputType("url")} value={siteUrl} onChange={event => setSiteUrl(event.target.value)} placeholder="https://your-team.atlassian.net"/>
      </Field>
      <Field label="Atlassian account email">
        <input className="input" type={redact.inputType()} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@company.com"/>
      </Field>
    </div>
    <Field
      label={config.configured ? "New API token (only to rotate)" : "API token"}
      hint="Create one at id.atlassian.com under Security. Every token expires within a year, so a sudden failure usually means rotation."
    >
      <input className="input" type="password" value={apiToken} onChange={event => setApiToken(event.target.value)} placeholder="Stored encrypted"/>
    </Field>
    {connect.error && <div className="inline-error"><TriangleAlert size={14}/><span>{connect.error.message}</span></div>}
    <div className="actions">
      <button
        className="button primary"
        disabled={connect.isPending || !apiToken || !siteUrl || !email || !secretStorageReady}
        onClick={() => connect.mutate()}
      >
        {connect.isPending ? <LoaderCircle className="spin" size={14}/> : <Zap size={14}/>}
        Connect Atlassian
      </button>
      {config.configured && <button className="button danger" onClick={() => confirm("Disconnect Atlassian?") && api.disconnectAtlassian().then(refresh)}>Disconnect</button>}
    </div>
  </div>;
}

const EXAMPLE_PROMPT = "Check the Growth board for anything in review, then check Confluence for comments left on my docs in the last 24 hours.";

/*
 * Starting points for the instruction box. A brief is only as good as the way it
 * is worded, and the wording that works is not obvious from an empty textarea:
 * these say what to look up, what shape the reply should take, and how long it
 * may run to. They are prefilled rather than created outright so the send time
 * and the phrasing can be adjusted before anything is scheduled.
 */
const BRIEF_TEMPLATES: {
  name: string;
  sendTime: string;
  blurb: string;
  icon: typeof Moon;
  prompt: string;
}[] = [
  {
    name: "End-of-day reflection",
    sendTime: "21:00",
    blurb: "Asks how the day went. Your reply is saved as that day's journal entry.",
    icon: Moon,
    prompt: "It is the end of my day. Check what I actually finished and captured today,"
      + " then text me one short line naming a thing or two I closed out and ask me how the day"
      + " went and whether there is anything I want to record before I forget it."
      + " Warm and brief, two sentences at most, no lists."
      + " Do not save anything yet — wait for my reply.",
  },
  {
    name: "Morning Jira sweep",
    sendTime: "08:00",
    blurb: "Reads the boards and spaces you pin and reports what moved overnight.",
    icon: SquareKanban,
    prompt: EXAMPLE_PROMPT,
  },
  {
    name: "Loose ends",
    sendTime: "16:00",
    blurb: "An afternoon nudge on whatever is still open and already late.",
    icon: ListChecks,
    prompt: "List anything of mine still open that was due today or earlier, oldest first,"
      + " and name the single thing most worth finishing before I stop for the day."
      + " At most five items, one text, no preamble.",
  },
];

export function DigestBriefsSettings({
  atlassianConfigured,
  quietHours,
  notify,
}: {
  atlassianConfigured: boolean;
  quietHours: { start: string | null; end: string | null };
  notify: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: briefs = [] } = useQuery({ queryKey: ["digest-briefs"], queryFn: api.digestBriefs });
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sendTime, setSendTime] = useState("08:00");
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["digest-briefs"] });
  const create = useMutation({
    mutationFn: () => api.createDigestBrief({ name, prompt, sendTime, resources: [], enabled: true }),
    onSuccess: () => {
      setName("");
      setPrompt("");
      invalidate();
      notify("Brief created. Pin the boards and spaces it should cover.");
    },
    onError: (error: Error) => notify(error.message),
  });
  return <div>
    <p className="integration-copy">
      A brief is an instruction your Agent runs on its own schedule and texts you the answer to. Pin the boards and
      spaces it covers so it never has to guess which ones you meant.
    </p>
    {!atlassianConfigured && <div className="inline-error">
      <TriangleAlert size={14}/>
      <span>Connect Atlassian above before pinning boards or spaces. Briefs about your local todos work either way.</span>
    </div>}
    <div className="brief-list">
      {briefs.map(brief => <BriefEditor
        key={brief.id}
        brief={brief}
        atlassianConfigured={atlassianConfigured}
        quietHours={quietHours}
        notify={notify}
        onChanged={invalidate}
      />)}
      {!briefs.length && <div className="brief-empty">
        <Sparkles size={15}/>
        <div>
          <strong>No briefs yet.</strong>
          <span>Start from a template below, or write one the way you would ask for it out loud, then use Test now to read it before it ever texts you.</span>
        </div>
      </div>}
    </div>
    <form className="brief-new" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <div className="brief-templates">
        <span className="brief-templates-label">Start from a template</span>
        <div className="brief-template-grid">
          {BRIEF_TEMPLATES.map(template => <button
            key={template.name}
            type="button"
            className={`brief-template ${name === template.name ? "selected" : ""}`}
            onClick={() => {
              setName(template.name);
              setPrompt(template.prompt);
              setSendTime(template.sendTime);
            }}
          >
            <span className="brief-template-icon"><template.icon size={14}/></span>
            <span>
              <strong>{template.name}</strong>
              <small>{template.blurb}</small>
            </span>
            <span className="brief-template-time">{humanTime(template.sendTime)}</span>
          </button>)}
        </div>
      </div>
      <div className="form-grid">
        <Field label="Brief name">
          <input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="Morning Jira sweep" required/>
        </Field>
        <Field label="Texted at">
          <input className="input" type="time" value={sendTime} onChange={event => setSendTime(event.target.value)}/>
        </Field>
      </div>
      <QuietHoursNote sendTime={sendTime} quietHours={quietHours}/>
      <Field
        label="Instruction"
        hint="Write it as you would say it. The Agent reads your boards and spaces to answer, then replies in one text."
      >
        <textarea
          className="input"
          rows={3}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          placeholder={EXAMPLE_PROMPT}
          required
        />
      </Field>
      <div className="actions">
        <button className="button primary" disabled={create.isPending || !name.trim() || !prompt.trim()}>
          <Plus size={14}/>Add brief
        </button>
      </div>
    </form>
    <small className="field-hint">
      Briefs are sent once per day at their own time, inside the quiet hours set in the delivery schedule, to the same
      number as your reminders.
    </small>
  </div>;
}

/*
 * A brief scheduled inside quiet hours is never sent, and nothing else in the
 * product says so: the send silently does not happen and the only evidence is a
 * text that never arrives. An evening reflection lands close enough to the
 * default 22:00 cutoff for this to be the likely first mistake.
 */
function QuietHoursNote({
  sendTime,
  quietHours,
}: {
  sendTime: string;
  quietHours: { start: string | null; end: string | null };
}) {
  const { start, end } = quietHours;
  if (!start || !end || !withinQuietHours(sendTime, start, end)) return null;
  return <div className="inline-error">
    <TriangleAlert size={14}/>
    <span>
      {humanTime(sendTime)} falls inside your quiet hours ({humanTime(start)}–{humanTime(end)}),
      so this brief will not be sent. Move it earlier, or change quiet hours in the delivery schedule.
    </span>
  </div>;
}

function BriefEditor({
  brief,
  atlassianConfigured,
  quietHours,
  notify,
  onChanged,
}: {
  brief: DigestBrief;
  atlassianConfigured: boolean;
  quietHours: { start: string | null; end: string | null };
  notify: (message: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(brief.name);
  const [prompt, setPrompt] = useState(brief.prompt);
  const [sendTime, setSendTime] = useState(brief.sendTime);
  const [enabled, setEnabled] = useState(brief.enabled);
  const [resources, setResources] = useState(brief.resources);
  const [confirmedSave, setConfirmedSave] = useState(false);
  const test = useMutation({
    mutationFn: () => api.testDigestBrief(brief.id),
    onError: (error: Error) => notify(error.message),
  });
  const save = useMutation({
    mutationFn: () => api.updateDigestBrief(brief.id, { name, prompt, sendTime, enabled, resources }),
    onSuccess: () => {
      onChanged();
      setConfirmedSave(true);
      // The old preview was drafted from the previous instruction, so it stops
      // being an answer about this brief the moment the brief changes.
      test.reset();
      notify(`“${name}” saved`);
    },
    onError: (error: Error) => notify(error.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDigestBrief(brief.id),
    onSuccess: () => { onChanged(); notify("Brief removed"); },
    onError: (error: Error) => notify(error.message),
  });
  const dirty = name !== brief.name || prompt !== brief.prompt || sendTime !== brief.sendTime
    || enabled !== brief.enabled || JSON.stringify(resources) !== JSON.stringify(brief.resources);
  // The confirmation is what tells you the write landed, so it outlives the
  // toast and only clears when the brief is edited again.
  const saved = confirmedSave && !dirty;
  return <details className="brief-card">
    <summary>
      <span className="brief-summary">
        <strong>{brief.name}</strong>
        <small>
          {brief.enabled ? `Texted at ${humanTime(brief.sendTime)}` : "Paused"}
          {" · "}
          {brief.resources.length
            ? `${brief.resources.length} pinned`
            : "nothing pinned"}
        </small>
      </span>
      {dirty && <span className="badge warn">Unsaved</span>}
      {saved && <span className="badge ok"><Check size={11}/>Saved</span>}
    </summary>
    <div className="brief-body">
      <div className="form-grid">
        <Field label="Brief name">
          <input className="input" value={name} onChange={event => setName(event.target.value)}/>
        </Field>
        <Field label="Texted at">
          <input className="input" type="time" value={sendTime} onChange={event => setSendTime(event.target.value)}/>
        </Field>
      </div>
      {enabled && <QuietHoursNote sendTime={sendTime} quietHours={quietHours}/>}
      <Field label="Instruction">
        <textarea className="input" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)}/>
      </Field>
      <ResourcePicker
        resources={resources}
        atlassianConfigured={atlassianConfigured}
        onChange={setResources}
      />
      <label className="toggle-row">
        <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>
        <span>Send this brief every day</span>
      </label>
      <div className="actions">
        <button className="button primary" disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
          {save.isPending ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}Save brief
        </button>
        <button className="button ghost" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <LoaderCircle className="spin" size={14}/> : <Play size={13}/>}Test now
        </button>
        <button className="button danger" disabled={remove.isPending} onClick={() => confirm(`Remove “${brief.name}”?`) && remove.mutate()}>
          <Trash2 size={13}/>Remove
        </button>
      </div>
      {saved && <p className="brief-saved" role="status">
        <Check size={13}/>Saved. It will text you at {humanTime(brief.sendTime)}
        {brief.enabled ? "" : " once you re-enable it"}.
      </p>}
      {test.isPending && <p className="brief-saved" role="status">
        <LoaderCircle className="spin" size={13}/>Running the brief against Jira and Confluence…
      </p>}
      {test.data && <div className="brief-preview">
        <header>
          <span><MessageSquareText size={12}/>Preview · not sent</span>
          <small>{test.data.text.length} characters · {test.data.date}</small>
        </header>
        <p>{test.data.text}</p>
        {dirty && <small className="field-hint">
          This ran the saved brief. Save your edits and test again to see them.
        </small>}
      </div>}
    </div>
  </details>;
}

function ResourcePicker({
  resources,
  atlassianConfigured,
  onChange,
}: {
  resources: DigestBriefResource[];
  atlassianConfigured: boolean;
  onChange: (next: DigestBriefResource[]) => void;
}) {
  const [boardFilter, setBoardFilter] = useState("");
  /*
   * Both lookups go through the agent tool endpoint, so the picker offers exactly
   * the boards and spaces the Agent itself can see. The board query needs a filter
   * because a real site has far more boards than are worth listing.
   */
  const boards = useQuery({
    queryKey: ["jira-boards", boardFilter],
    queryFn: () => api.jiraBoards(boardFilter),
    enabled: atlassianConfigured && boardFilter.trim().length >= 2,
  });
  const spaces = useQuery({
    queryKey: ["confluence-spaces"],
    queryFn: api.confluenceSpaces,
    enabled: atlassianConfigured,
  });
  const pinned = new Set(resources.map(resource => `${resource.type}:${resource.id}`));
  const add = (resource: DigestBriefResource) => {
    if (pinned.has(`${resource.type}:${resource.id}`)) return;
    onChange([...resources, resource]);
  };
  const drop = (resource: DigestBriefResource) =>
    onChange(resources.filter(entry => !(entry.type === resource.type && entry.id === resource.id)));
  return <div className="resource-picker">
    <div className="resource-pins">
      {resources.map(resource => <span className="resource-pin" key={`${resource.type}:${resource.id}`}>
        {resource.type === "jira_board" ? <SquareKanban size={11}/> : <BookText size={11}/>}
        {resource.name || resource.id}
        <button type="button" aria-label={`Unpin ${resource.name || resource.id}`} onClick={() => drop(resource)}>
          <X size={11}/>
        </button>
      </span>)}
      {!resources.length && <small className="field-hint">
        Nothing pinned. The Agent will resolve boards and spaces by name from the instruction, which is slower and less
        certain.
      </small>}
    </div>
    <div className="form-grid">
      <Field label="Pin a Jira board" hint={boards.error?.message}>
        <input
          className="input"
          value={boardFilter}
          onChange={event => setBoardFilter(event.target.value)}
          placeholder={atlassianConfigured ? "Search board names" : "Connect Atlassian first"}
          disabled={!atlassianConfigured}
        />
      </Field>
      <Field label="Pin a Confluence space" hint={spaces.error?.message}>
        <select
          className="select"
          value=""
          disabled={!atlassianConfigured || !spaces.data?.spaces.length}
          onChange={event => {
            const space = spaces.data?.spaces.find(entry => entry.key === event.target.value);
            if (space?.key) add({ type: "confluence_space", id: space.key, name: space.name });
          }}
        >
          <option value="">{atlassianConfigured ? "Choose a space" : "Connect Atlassian first"}</option>
          {spaces.data?.spaces.map(space => space.key
            ? <option key={space.key} value={space.key}>{space.name || space.key}</option>
            : null)}
        </select>
      </Field>
    </div>
    {boards.isFetching && <small className="field-hint">Searching boards…</small>}
    {Boolean(boards.data?.boards.length) && <div className="resource-results">
      {boards.data?.boards.map((board) => {
        const alreadyPinned = pinned.has(`jira_board:${board.id}`);
        return <button
          type="button"
          key={board.id}
          className="button ghost"
          disabled={alreadyPinned}
          onClick={() => add({ type: "jira_board", id: String(board.id), name: board.name })}
        >
          {alreadyPinned ? <Check size={11}/> : <Plus size={11}/>}
          {board.name || `Board ${board.id}`}{board.project_key ? ` · ${board.project_key}` : ""}
        </button>;
      })}
    </div>}
    {boards.data && !boards.data.boards.length && <small className="field-hint">
      No board name matches “{boardFilter.trim()}”. Board search matches part of a name, so try a shorter word.
    </small>}
  </div>;
}
