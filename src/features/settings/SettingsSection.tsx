import type { ReactNode } from "react";
import { Settings2 } from "lucide-react";

/**
 * One group of related settings, always open: the tab it sits under already
 * did the sorting, so there is nothing left to collapse.
 */
export function SettingsSection({
  sectionId,
  title,
  description,
  status,
  icon: Icon,
  children,
}: {
  sectionId: string;
  title: string;
  description: string;
  status?: string;
  icon: typeof Settings2;
  children: ReactNode;
}) {
  return <section className="card settings-section" aria-labelledby={`settings-section-${sectionId}`}>
    <header className="settings-section-head">
      <span className="settings-section-icon"><Icon size={18}/></span>
      <span className="settings-section-copy">
        <strong id={`settings-section-${sectionId}`}>{title}</strong>
        <small>{description}</small>
      </span>
      {status && <span className="settings-section-status">{status}</span>}
    </header>
    <div className="settings-section-body">{children}</div>
  </section>;
}
