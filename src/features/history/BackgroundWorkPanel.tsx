import { NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Mail, MessageSquareText, RefreshCw, UserRound } from "lucide-react";
import { api } from "../../api";
import type { BackgroundChat, DigestDraft, SweepRun } from "../../types";
import { ErrorState, Loading, MarkdownContent } from "../../components/ui";
import { friendlyDate, useTimezone } from "../../lib/timezone";

/**
 * What the assistant does on its own, one card per chat: when it last read the
 * conversation for facts and what it kept, and the Soul and profile it works
 * from. The scratch threads these jobs write on are not conversations, so they
 * are not listed beside them; everything shown here is read from what they left.
 */

const PROFILE_STATE: Record<BackgroundChat["profileState"], { label: string; hint: string }> = {
  current: { label: "Up to date", hint: "Matches the facts it is written from" },
  stale: { label: "Rewrite due", hint: "Facts changed since it was written; it is rewritten overnight" },
  empty: { label: "Nothing to write from", hint: "No facts saved for this chat yet" },
};

const DIGEST_KINDS: Record<string, string> = {
  daily_digest: "Daily digest",
  digest_brief: "Digest brief",
  evening_checkin: "Evening check-in",
  follow_up: "Follow-up",
  checkin_ask_draft: "Check-in wording draft",
};

function kept(sweep: SweepRun): string {
  const created = sweep.changes.filter(change => change.action === "created").length;
  const updated = sweep.changes.length - created;
  const parts = [
    created ? `kept ${created} new ${created === 1 ? "fact" : "facts"}` : "",
    updated ? `updated ${updated}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing new";
}

function SweepList({ sweeps, timezone }: { sweeps: SweepRun[]; timezone: string }) {
  if (!sweeps.length) {
    return <p className="background-empty">Not read yet. It reads a chat once it has been quiet for twenty minutes after four or more new messages.</p>;
  }
  return <ol className="background-sweeps">
    {sweeps.map(sweep => <li key={sweep.id} className={sweep.status === "failed" ? "failed" : undefined}>
      <div className="background-sweep-head">
        <time>{friendlyDate(sweep.at, timezone)}</time>
        <span className="badge">{sweep.status === "failed" ? "failed" : sweep.status === "sent" ? kept(sweep) : sweep.status}</span>
      </div>
      {sweep.status === "failed" && sweep.error && <p className="background-error">{sweep.error}</p>}
      {sweep.changes.length > 0 && <ul>
        {sweep.changes.map((change, index) => <li key={`${change.memoryId ?? "memory"}-${index}`}>
          <span className={`background-change ${change.action}`}>{change.action === "created" ? "New" : "Updated"}</span>
          <NavLink to="/memories">{change.title}</NavLink>
        </li>)}
      </ul>}
      {sweep.status === "sent" && !sweep.changes.length && sweep.summary && <p className="background-summary">{sweep.summary}</p>}
    </li>)}
  </ol>;
}

function ChatCard({ chat, timezone }: { chat: BackgroundChat; timezone: string }) {
  const queryClient = useQueryClient();
  const rewrite = useMutation({
    mutationFn: () => chat.kind === "owner" ? api.refreshProfile() : api.refreshGroupProfile(chat.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["background-activity"] });
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
      void queryClient.invalidateQueries({ queryKey: ["life-areas"] });
    },
  });
  const last = chat.sweeps.find(sweep => sweep.status === "sent");
  const state = PROFILE_STATE[chat.profileState];
  return <article className="card card-pad background-card" aria-label={chat.name}>
    <header className="background-card-head">
      <span className="background-card-mark">{chat.kind === "owner" ? <UserRound size={15}/> : <MessageSquareText size={15}/>}</span>
      <div>
        <strong>{chat.name}</strong>
        <small>{chat.kind === "owner" ? "Your own chat" : "Group chat"}</small>
      </div>
      <span className="background-last">{last
        ? <>Last read {friendlyDate(last.at, timezone)} · {kept(last)}</>
        : "Not read yet"}</span>
    </header>

    <section>
      <h4><Brain size={13}/>Memory sweeps</h4>
      <SweepList sweeps={chat.sweeps} timezone={timezone}/>
    </section>

    <section>
      <h4>Soul</h4>
      {chat.soul
        ? <div className="background-text"><MarkdownContent content={chat.soul}/></div>
        : <p className="background-empty">No Soul yet; the assistant uses its default voice here.</p>}
    </section>

    <section>
      <h4>Profile <span className={`badge background-state ${chat.profileState}`} title={state.hint}>{state.label}</span></h4>
      {chat.profile
        ? <div className="background-text"><MarkdownContent content={chat.profile}/></div>
        : <p className="background-empty">{state.hint}.</p>}
      <div className="background-profile-foot">
        <small>
          {chat.profileUpdatedAt ? `Written ${friendlyDate(chat.profileUpdatedAt, timezone)}` : "Not written yet"}
          {chat.lastProfileRun?.status === "failed" && chat.lastProfileRun.note ? ` · last overnight run failed: ${chat.lastProfileRun.note}` : ""}
        </small>
        <button
          type="button"
          className="button"
          disabled={rewrite.isPending || chat.profileState === "empty"}
          aria-busy={rewrite.isPending}
          onClick={() => rewrite.mutate()}
        >
          <RefreshCw size={13} className={rewrite.isPending ? "spin" : undefined}/>Refresh profile
        </button>
      </div>
      {rewrite.isError && <p role="alert" className="background-error">{rewrite.error.message}</p>}
    </section>
  </article>;
}

function DigestList({ digests, timezone }: { digests: DigestDraft[]; timezone: string }) {
  return <section className="card card-pad background-digests" aria-label="Digest drafts">
    <header className="card-title">
      <h3>Digest drafts</h3>
      <Mail size={15}/>
    </header>
    <p className="background-empty">Where digests, briefs, check-ins and follow-ups are written before they are texted.</p>
    {digests.length ? <ul>
      {digests.map(digest => <li key={digest.id}>
        <div className="background-sweep-head">
          <strong>{digest.label ?? DIGEST_KINDS[digest.kind] ?? "Scheduled message"}</strong>
          <span className="badge">{DIGEST_KINDS[digest.kind] ?? "Scheduled message"}</span>
          <time>{friendlyDate(digest.at, timezone)}</time>
        </div>
        {digest.draft ? <MarkdownContent content={digest.draft}/> : <p className="background-empty">No draft came back.</p>}
      </li>)}
    </ul> : <p className="background-empty">Nothing drafted yet.</p>}
  </section>;
}

export function BackgroundWorkPanel() {
  const timezone = useTimezone();
  const { data, isLoading, error } = useQuery({
    queryKey: ["background-activity"],
    queryFn: api.backgroundActivity,
    refetchInterval: 30_000,
  });
  if (isLoading) return <Loading/>;
  if (error || !data) return <ErrorState error={error}/>;
  return <div className="background-work">
    <div className="background-grid">
      {data.chats.map(chat => <ChatCard key={chat.id} chat={chat} timezone={timezone}/>)}
    </div>
    <DigestList digests={data.digests} timezone={timezone}/>
  </div>;
}
