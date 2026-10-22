import type { CSSProperties, ReactNode } from "react";
import { Empty } from "../../components/ui";
import { bucketLabel, shortDate } from "./format";

/*
 * The charts are drawn from plain elements and SVG rather than a charting
 * library: they are small, they take their colours from the theme's variables
 * so dark mode costs nothing, and they lay out the same in a test as in a
 * browser. A value is readable from its hover tooltip for a pointer, and from the
 * chart's accessible name or a hidden summary beside it for everything else, so
 * none of it is colour or hovering alone.
 */

export type Series = { label: string; color: string; values: number[] };

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function Legend({ series }: { series: Array<{ label: string; color: string; total?: number }> }) {
  return <ul className="ins-legend">
    {series.map(item => <li key={item.label}>
      <i style={{ background: item.color }} aria-hidden="true"/>{item.label}
      {item.total !== undefined && <strong>{item.total}</strong>}
    </li>)}
  </ul>;
}

/**
 * One column per bucket. Grouped puts each series side by side; stacked piles
 * them, so a column's height is its total.
 */
export function BarSeries({ buckets, granularity, series, stacked = false, label }: {
  buckets: string[];
  granularity: "day" | "week";
  series: Series[];
  stacked?: boolean;
  label: string;
}) {
  const totals = buckets.map((_, index) => sum(series.map(item => item.values[index] ?? 0)));
  const peak = Math.max(1, ...(stacked ? totals : series.flatMap(item => item.values)));
  const everything = sum(totals);
  if (!everything) return <Empty label="Nothing to chart in this period yet."/>;
  return <figure className="ins-chart">
    <div
      className={`ins-bars${stacked ? " stacked" : ""}`}
      role="img"
      aria-label={`${label}: ${series.map(item => `${sum(item.values)} ${item.label.toLowerCase()}`).join(", ")}; `
        + `busiest ${bucketLabel(buckets[totals.indexOf(Math.max(...totals))], granularity)} with ${Math.max(...totals)}`}
    >
      {buckets.map((key, index) => <div
        key={key}
        className="ins-bars-col"
        title={`${bucketLabel(key, granularity)} · ${series.map(item => `${item.values[index] ?? 0} ${item.label.toLowerCase()}`).join(", ")}`}
      >
        {series.map(item => <i
          key={item.label}
          style={{ height: `${((item.values[index] ?? 0) / peak) * 100}%`, background: item.color } as CSSProperties}
        />)}
      </div>)}
    </div>
    <div className="ins-axis" aria-hidden="true">
      <span>{shortDate(buckets[0])}</span>
      <span>peak {peak}</span>
      <span>{shortDate(buckets[buckets.length - 1])}</span>
    </div>
    <Legend series={series.map(item => ({ label: item.label, color: item.color, total: sum(item.values) }))}/>
  </figure>;
}

/**
 * A line through the buckets that have a value. A gap in the data is a gap in
 * the line, since a day with no entry is not a day that felt like zero.
 */
export function LineSeries({ buckets, granularity, values, min, max, color = "var(--accent)", label }: {
  buckets: string[];
  granularity: "day" | "week";
  values: Array<number | null>;
  min: number;
  max: number;
  color?: string;
  label: string;
}) {
  const present = values.filter((value): value is number => value !== null);
  if (!present.length) return <Empty label="Nothing to chart in this period yet."/>;
  const steps = Math.max(1, buckets.length - 1);
  const x = (index: number) => buckets.length === 1 ? 50 : (index / steps) * 100;
  const y = (value: number) => 100 - ((value - min) / (max - min)) * 100;
  const segments: string[] = [];
  let run: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 1) segments.push(run.join(" "));
      run = [];
    } else run.push(`${x(index)},${y(value)}`);
  });
  if (run.length > 1) segments.push(run.join(" "));
  return <figure className="ins-chart">
    <div className="ins-line" role="img" aria-label={`${label}: ${present.length} points, averaging ${(sum(present) / present.length).toFixed(1)}, `
      + `from ${Math.min(...present).toFixed(1)} to ${Math.max(...present).toFixed(1)}`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[0, 25, 50, 75, 100].map(line => <line key={line} x1="0" x2="100" y1={line} y2={line} className="ins-gridline"/>)}
        {segments.map(points => <polyline key={points} points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
      </svg>
      {values.map((value, index) => value === null ? null : <i
        key={buckets[index]}
        className="ins-dot"
        style={{ left: `${x(index)}%`, top: `${y(value)}%`, background: color } as CSSProperties}
        title={`${bucketLabel(buckets[index], granularity)} · ${value}`}
      />)}
      <span className="ins-line-max" aria-hidden="true">{max}</span>
      <span className="ins-line-min" aria-hidden="true">{min}</span>
    </div>
    <div className="ins-axis" aria-hidden="true">
      <span>{shortDate(buckets[0])}</span>
      <span>{shortDate(buckets[buckets.length - 1])}</span>
    </div>
  </figure>;
}

/** A handful of labelled bars side by side, such as how long things took. */
export function Columns({ items, color = "var(--accent)", label, format = String }: {
  items: Array<{ label: string; count: number; color?: string }>;
  color?: string;
  label: string;
  format?: (count: number) => string;
}) {
  const peak = Math.max(1, ...items.map(item => item.count));
  if (!sum(items.map(item => item.count))) return <Empty label="Nothing to chart in this period yet."/>;
  return <div className="ins-columns" role="img" aria-label={`${label}: ${items.map(item => `${item.label} ${item.count}`).join(", ")}`}>
    {items.map(item => <div key={item.label} className="ins-column" title={`${item.label} · ${item.count}`}>
      <strong>{format(item.count)}</strong>
      <span className="ins-column-track"><i style={{ height: `${(item.count / peak) * 100}%`, background: item.color ?? color }}/></span>
      <small>{item.label}</small>
    </div>)}
  </div>;
}

/** Horizontal bars with the name first, for things ranked rather than ordered in time. */
export function BarList({ items, color = "var(--accent)", format = String, empty = "Nothing here yet." }: {
  items: Array<{ label: string; count: number; detail?: string; color?: string | null }>;
  color?: string;
  format?: (count: number) => string;
  empty?: string;
}) {
  const peak = Math.max(1, ...items.map(item => item.count));
  if (!items.length || !sum(items.map(item => item.count))) return <Empty label={empty}/>;
  return <ul className="ins-barlist">
    {items.map((item, index) => <li key={`${index}:${item.label}`} title={`${item.label} · ${item.count}`}>
      <span className="ins-barlist-name">{item.label}</span>
      <span className="ins-barlist-track"><i style={{ width: `${(item.count / peak) * 100}%`, background: item.color ?? color }}/></span>
      <strong>{format(item.count)}</strong>
      {item.detail && <small>{item.detail}</small>}
    </li>)}
  </ul>;
}

/** One bar split into the shares of a whole, with the names beneath it. */
export function StackedBar({ items, label }: { items: Array<{ label: string; count: number; color: string }>; label: string }) {
  const total = sum(items.map(item => item.count));
  if (!total) return <Empty label="Nothing to chart in this period yet."/>;
  return <div className="ins-share">
    <div className="ins-share-bar" role="img" aria-label={`${label}: ${items.map(item => `${item.label} ${item.count}`).join(", ")}`}>
      {items.filter(item => item.count).map(item => <i
        key={item.label}
        style={{ flexGrow: item.count, background: item.color }}
        title={`${item.label} · ${item.count} (${Math.round((item.count / total) * 100)}%)`}
      />)}
    </div>
    <Legend series={items.map(item => ({ label: item.label, color: item.color, total: item.count }))}/>
  </div>;
}

/**
 * A grid of cells shaded by value. Rows are labelled down the side; columns can
 * be labelled sparsely along the top. A `null` is a cell with nothing in it,
 * kept apart from a real low value.
 */
export function Heatmap({ rows, rowLabels, columnLabel, min = 0, max, cell, label, color = "var(--accent)" }: {
  rows: Array<Array<number | null>>;
  rowLabels: string[];
  columnLabel?: (index: number) => string | undefined;
  min?: number;
  max?: number;
  cell: (value: number, row: number, column: number) => string;
  label: string;
  color?: string;
}) {
  const present = rows.flat().filter((value): value is number => value !== null);
  const peak = max ?? Math.max(1, ...present);
  if (!present.length || (max === undefined && !present.some(value => value > 0))) return <Empty label="Nothing to chart in this period yet."/>;
  const columns = rows[0]?.length ?? 0;
  // The grid is a picture; what it says is listed beside it. A single row is read out cell by cell, a tall one by the strongest cell in each row.
  const spoken = rows.flatMap((row, rowIndex) => {
    if (rows.length === 1) return row.flatMap((value, column) => value === null ? [] : [cell(value, rowIndex, column)]);
    const top = Math.max(0, ...row.map(value => value ?? 0));
    const column = row.findIndex(value => value === top);
    return top > 0 && column >= 0 ? [cell(top, rowIndex, column)] : [];
  });
  return <div role="group" aria-label={label}>
    <ul className="visually-hidden">{spoken.map((text, index) => <li key={index}>{text}</li>)}</ul>
    <div className="ins-heat" aria-hidden="true" style={{ "--cols": columns, "--heat-color": color } as CSSProperties}>
      {columnLabel && <div className="ins-heat-head">
        <span/>
        {Array.from({ length: columns }, (_, index) => <small key={index}>{columnLabel(index)}</small>)}
      </div>}
      {rows.map((row, rowIndex) => <div key={rowLabels[rowIndex]} className="ins-heat-row">
        <span className="ins-heat-label">{rowLabels[rowIndex]}</span>
        {row.map((value, column) => <i
          key={column}
          className={value === null ? "empty" : undefined}
          style={value === null ? undefined : { "--heat": Math.max(0, Math.min(1, (value - min) / (peak - min || 1))) } as CSSProperties}
          title={value === null ? `${rowLabels[rowIndex]} · none` : `${rowLabels[rowIndex]} · ${cell(value, rowIndex, column)}`}
        />)}
      </div>)}
    </div>
  </div>;
}

/** A titled tile in the dashboard's grid. */
export function InsightCard({ title, note, children, wide = false }: { title: string; note?: string; children: ReactNode; wide?: boolean }) {
  return <article className={`card card-pad ins-card${wide ? " wide" : ""}`}>
    <div className="card-title"><h3>{title}</h3>{note && <small className="ins-note">{note}</small>}</div>
    {children}
  </article>;
}
