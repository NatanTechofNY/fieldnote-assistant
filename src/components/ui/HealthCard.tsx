import type { Database } from "lucide-react";

export function HealthCard({ title, ok, detail, icon: Icon }: {
  title: string;
  ok: boolean;
  detail: string;
  icon: typeof Database;
}) {
  return <article className="card health-card">
    <div className="health-icon"><Icon size={13}/></div>
    <strong>{title}</strong>
    <p>{detail}</p>
    <div className="eyebrow"><span className={`dot ${ok ? "ok" : ""}`}/>{ok ? "Connected" : "Needs setup"}</div>
  </article>;
}
