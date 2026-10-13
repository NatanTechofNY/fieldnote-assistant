import { type KeyboardEvent, type ReactNode, useRef } from "react";
import type { LucideIcon } from "lucide-react";

export type SettingsTabDef = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A short state shown as a pill beside the label: "Connected", "2 active". */
  status?: string;
  /** Draws the pill as a warning, for a tab with something not set up. */
  attention?: boolean;
};

/**
 * The horizontal menu across the top of Settings. A tablist in the WAI-ARIA
 * sense: one tab is in the tab order, the arrow keys, Home, and End move
 * between them, and the panel below is labelled by the selected one.
 */
export function SettingsTabs({ tabs, active, onSelect, children }: {
  tabs: SettingsTabDef[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };
  return <>
    <div className="settings-tabs-bar">
      <div className="settings-tabs" role="tablist" aria-label="Settings" aria-orientation="horizontal">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return <button
            key={tab.id}
            ref={element => { refs.current[tab.id] = element; }}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="settings-tabpanel"
            tabIndex={selected ? 0 : -1}
            className={`settings-tab ${selected ? "active" : ""}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={event => move(event, index)}
          >
            <tab.icon size={15} aria-hidden="true"/>
            <span>{tab.label}</span>
            {tab.status && <small className={`settings-tab-status ${tab.attention ? "attention" : ""}`}>{tab.status}</small>}
          </button>;
        })}
      </div>
    </div>
    <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${active}`} className="settings-stack" tabIndex={-1}>
      {children}
    </div>
  </>;
}
