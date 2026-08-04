import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useTheme } from "../../lib/theme";

const options: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * Compact form for the sidebar, labelled form for settings. Both drive the same
 * preference, so the two surfaces cannot disagree.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  return <div className={`theme-toggle ${compact ? "compact" : ""}`} role="group" aria-label="Appearance">
    {options.map(({ value, label, icon: Icon }) => (
      <button
        key={value}
        type="button"
        className={preference === value ? "active" : ""}
        aria-pressed={preference === value}
        aria-label={compact ? label : undefined}
        title={compact ? label : undefined}
        onClick={() => setPreference(value)}
      >
        <Icon size={13}/>{!compact && <span>{label}</span>}
      </button>
    ))}
  </div>;
}
