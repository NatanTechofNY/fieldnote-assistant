import { type ReactNode, useState } from "react";
import { ChevronDown, Settings2 } from "lucide-react";

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
  const [isOpen, setIsOpen] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("fieldnote:settings-sections") || "{}") as Record<string, boolean>;
      return saved[sectionId] === true;
    } catch {
      return false;
    }
  });
  const persistOpenState = (nextOpen: boolean) => {
    setIsOpen(nextOpen);
    try {
      const saved = JSON.parse(window.localStorage.getItem("fieldnote:settings-sections") || "{}") as Record<string, boolean>;
      window.localStorage.setItem("fieldnote:settings-sections", JSON.stringify({ ...saved, [sectionId]: nextOpen }));
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
    }
  };
  return <details className="card settings-section" open={isOpen} onToggle={event => persistOpenState(event.currentTarget.open)}>
    <summary>
      <span className="settings-section-icon"><Icon size={18}/></span>
      <span className="settings-section-copy"><strong>{title}</strong><small>{description}</small></span>
      {status && <span className="settings-section-status">{status}</span>}
      <ChevronDown className="settings-section-chevron" size={18}/>
    </summary>
    <div className="settings-section-body">{children}</div>
  </details>;
}
