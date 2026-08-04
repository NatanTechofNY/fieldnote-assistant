import { BookOpen, FileText, Sparkles } from "lucide-react";
import type { MemoryKind } from "../../types";

const kindColor: Record<MemoryKind, string> = {
  fact: "var(--warn)",
  note: "var(--info)",
  journal: "var(--accent)",
};

export function MemoryIcon({ kind }: { kind: MemoryKind }) {
  const Icon = kind === "fact" ? Sparkles : kind === "note" ? FileText : BookOpen;
  return <Icon size={16} style={{ color: kindColor[kind] }}/>;
}
