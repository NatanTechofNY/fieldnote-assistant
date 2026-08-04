import { ChevronDown, Database, Zap } from "lucide-react";
import {
  traceResultSummary, traceRunSummary, traceSucceeded, type HistoryToolTraceData,
} from "./tool-traces";

function sourceClass(source: HistoryToolTraceData["source"]): string {
  return `source-${source.toLowerCase().replace(" ", "-")}`;
}

/**
 * One card per call is right when a turn made one call. Past that the summary
 * rows repeat themselves, so a run is announced by its shape — how many calls,
 * which tools, whether any failed — and opens to the individual cards.
 */
export function HistoryToolGroup({ traces }: { traces: HistoryToolTraceData[] }) {
  if (traces.length === 1) return <HistoryToolTrace trace={traces[0]}/>;
  const failed = traces.filter(trace => !traceSucceeded(trace)).length;
  const sources = [...new Set(traces.map(trace => trace.source))];
  return <details className={`history-trace history-trace-run ${failed ? "" : "successful"}`}>
    <summary>
      <span className="history-trace-icon"><Zap size={12}/></span>
      <span className="history-trace-name">
        <small>{traces.length} tool calls{failed ? ` · ${failed} failed` : ""}</small>
        <strong>{traceRunSummary(traces)}</strong>
      </span>
      <span className="history-trace-run-sources">
        {sources.map(source => <span key={source} className={`history-trace-source ${sourceClass(source)}`}>{source}</span>)}
      </span>
      <span className="history-trace-result"><ChevronDown size={13}/></span>
    </summary>
    <div className="history-trace-run-body">
      {traces.map((trace, index) => <HistoryToolTrace
        key={trace.toolCallId ?? `${trace.name}-${index}`}
        trace={trace}
      />)}
    </div>
  </details>;
}

export function HistoryToolTrace({ trace }: { trace: HistoryToolTraceData }) {
  const successful = traceSucceeded(trace);
  return <details className={`history-trace ${successful ? "successful" : ""}`}>
    <summary>
      <span className="history-trace-icon"><Zap size={12}/></span>
      <span className="history-trace-name"><small>Tool call</small><strong>{trace.name}</strong></span>
      <span className={`history-trace-source ${sourceClass(trace.source)}`}>{trace.source}</span>
      {trace.indexing && <span className={`history-trace-source source-algolia index-${trace.indexing.status}`}>
        Algolia · {trace.indexing.status === "done" ? "indexed" : trace.indexing.status}
      </span>}
      <span className="history-trace-result">{traceResultSummary(trace.output)}</span>
    </summary>
    <div className="history-trace-body">
      {trace.indexing && <div className="history-indexing">
        <Database size={12}/>
        <span><strong>SQLite write complete</strong> → Algolia {trace.indexing.status === "done" ? "search projection indexed" : `sync ${trace.indexing.status}`}</span>
        {trace.indexing.lastError && <small>{trace.indexing.lastError}</small>}
      </div>}
      <section><div className="history-trace-label">Arguments sent</div><pre>{JSON.stringify(trace.input ?? {}, null, 2)}</pre></section>
      <section><div className="history-trace-label">Data returned · {trace.source}</div><pre>{JSON.stringify(trace.output ?? null, null, 2)}</pre></section>
    </div>
  </details>;
}
