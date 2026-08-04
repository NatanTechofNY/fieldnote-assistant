import { LoaderCircle, TriangleAlert } from "lucide-react";

export function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

export function Loading() {
  return <div className="empty state-loading"><LoaderCircle className="spin" size={16}/>Loading…</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  return <div className="card card-pad state-error" role="alert">
    <TriangleAlert size={16}/>
    <h3>Couldn’t load this view</h3>
    <p>{error instanceof Error ? error.message : "Start the local API and try again."}</p>
  </div>;
}
