import type { ChannelMessage } from "../../types";

export type HistoryToolTraceData = {
  name: string;
  /** Identifies the same call across the two places it is stored. */
  toolCallId?: string;
  source: "Algolia" | "SQLite" | "Agent Studio";
  state?: string;
  input?: unknown;
  output?: unknown;
  indexing?: {
    destination?: string;
    entityType?: string;
    operation?: string;
    status?: string;
    lastError?: string | null;
    updatedAt?: string | null;
  };
};

function toolSource(name: string): HistoryToolTraceData["source"] {
  if (name.includes("algolia_search")) return "Algolia";
  if (/^(get|list|create|update|set|delete)_(todos?|memories|memory|reminders?|life_areas?)$|^get_(agenda|review_evidence|reflection_evidence|conversation_context)$/.test(name)) return "SQLite";
  return "Agent Studio";
}

/** Agent Studio uses the snake-cased spelling; our own tool rows use the camel one. */
function readToolCallId(source: Record<string, unknown>): string | undefined {
  const value = source.toolCallId ?? source.tool_call_id;
  return typeof value === "string" ? value : undefined;
}

function messageToolTraces(message: ChannelMessage): HistoryToolTraceData[] {
  if (message.role === "tool") {
    return [{
      name: message.content,
      toolCallId: readToolCallId(message.metadata),
      source: toolSource(message.content),
      input: message.metadata.input,
      output: message.metadata.output,
      state: "output-available",
      indexing: message.metadata.indexing as HistoryToolTraceData["indexing"],
    }];
  }
  const parts = Array.isArray(message.metadata.parts)
    ? message.metadata.parts as Array<Record<string, unknown>>
    : [];
  return parts
    .filter(part => typeof part.type === "string" && part.type.startsWith("tool-"))
    .map(part => {
      const name = String(part.type).slice(5);
      return {
        name,
        toolCallId: readToolCallId(part),
        source: toolSource(name),
        state: typeof part.state === "string" ? part.state : undefined,
        input: part.input,
        output: part.output,
        indexing: part.indexing as HistoryToolTraceData["indexing"],
      };
    });
}

/**
 * A tool call is stored twice: once as its own `role='tool'` row written when it
 * returns, and again inside the `parts` of the assistant message that closes the
 * turn. Keeping only the first sighting in thread order leaves each card beside
 * the step that produced it rather than repeating the whole set under the reply.
 */
export function threadToolTraces(messages: ChannelMessage[]): Map<string, HistoryToolTraceData[]> {
  const seen = new Set<string>();
  return new Map(messages.map(message => [
    message.id,
    messageToolTraces(message).filter(trace => {
      if (!trace.toolCallId) return true;
      if (seen.has(trace.toolCallId)) return false;
      seen.add(trace.toolCallId);
      return true;
    }),
  ]));
}

export function traceSucceeded(trace: HistoryToolTraceData): boolean {
  return trace.state === "output-available"
    && !(trace.output && typeof trace.output === "object" && "success" in trace.output
      && !(trace.output as { success: boolean }).success);
}

export type HistoryTimelineRow =
  | { kind: "message"; key: string; message: ChannelMessage; traces: HistoryToolTraceData[] }
  | { kind: "tools"; key: string; traces: HistoryToolTraceData[]; createdAt: string };

/**
 * A turn that calls five tools writes five rows, and each one used to arrive as
 * its own bubble carrying its own timestamp — a column of near-identical chrome
 * that pushed the reply the reader came for off the screen. A run of adjacent
 * tool rows collapses into one dated entry instead, so the steps stay auditable
 * without competing with the conversation for the reader's attention.
 */
export function historyTimeline(messages: ChannelMessage[]): HistoryTimelineRow[] {
  const tracesByMessage = threadToolTraces(messages);
  const rows: HistoryTimelineRow[] = [];
  let run: Extract<HistoryTimelineRow, { kind: "tools" }> | null = null;
  for (const message of messages) {
    const traces = tracesByMessage.get(message.id) ?? [];
    if (message.role === "tool") {
      // A deduplicated tool row carries nothing but its trace, so nothing is left to show.
      if (!traces.length) continue;
      if (run) {
        run.traces.push(...traces);
        run.createdAt = message.createdAt;
      } else {
        run = { kind: "tools", key: message.id, traces: [...traces], createdAt: message.createdAt };
        rows.push(run);
      }
      continue;
    }
    run = null;
    rows.push({ kind: "message", key: message.id, message, traces });
  }
  return rows;
}

/** `set_todo_status` three times in a row is one fact about the turn, not three. */
export function traceRunSummary(traces: HistoryToolTraceData[]): string {
  const counts = new Map<string, number>();
  for (const trace of traces) counts.set(trace.name, (counts.get(trace.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(", ");
}

export function traceResultSummary(output: unknown): string {
  if (output === undefined) return "No result captured";
  const value = output && typeof output === "object" && "data" in output
    ? (output as { data: unknown }).data
    : output;
  if (value && typeof value === "object" && "hits" in value && Array.isArray((value as { hits: unknown[] }).hits)) {
    const count = (value as { hits: unknown[] }).hits.length;
    return `${count} search result${count === 1 ? "" : "s"} found`;
  }
  if (Array.isArray(value)) return `${value.length} record${value.length === 1 ? "" : "s"} returned`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.title === "string") return `Record: ${record.title}`;
    if (typeof record.content === "string") return "Memory record returned";
  }
  if (output && typeof output === "object" && "success" in output) {
    return (output as { success: boolean }).success ? "Completed successfully" : "Tool failed";
  }
  return "Result captured";
}
