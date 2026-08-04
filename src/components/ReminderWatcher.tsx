import { useEffect, useState } from "react";
import { Clock3, X } from "lucide-react";
import { api } from "../api";
import { Toast } from "./ui";

const STORAGE_KEY = "fieldnote:dismissed-reminders";

/*
 * Dismissals outlive the tab. A due date keeps its reminder row `pending`
 * indefinitely, because a date is not a notification and nothing ever marks one
 * delivered, so in-memory state meant every reload brought the same toast back
 * for a task the user had already acknowledged.
 */
function readDismissed(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Losing the record only costs a repeated toast, so this is not worth surfacing.
  }
}

export function ReminderWatcher() {
  const [reminder, setReminder] = useState<{ id: string; todo_title?: string } | null>(null);
  useEffect(() => {
    const check = () => api.dueReminders().then(items => {
      const due = new Set(items.map(item => item.id));
      // Forgetting ids that are no longer due keeps this from growing by one
      // entry for every reminder the account has ever had.
      const dismissed = readDismissed().filter(id => due.has(id));
      writeDismissed(dismissed);
      setReminder(current => {
        if (current && due.has(current.id)) return current;
        return items.find(item => !dismissed.includes(item.id)) || null;
      });
    }).catch(() => undefined);
    const timer = window.setInterval(check, 30_000); check();
    return () => window.clearInterval(timer);
  }, []);
  const dismiss = () => {
    if (reminder) writeDismissed([...new Set([...readDismissed(), reminder.id])]);
    setReminder(null);
  };
  if (!reminder) return null;
  return <Toast>
    <Clock3 size={16}/>
    <div>
      <div className="eyebrow">Local reminder</div>
      <strong>{reminder.todo_title || "A task is due"}</strong>
    </div>
    <button aria-label="Dismiss reminder" className="button icon ghost" onClick={dismiss}><X size={13}/></button>
  </Toast>;
}
