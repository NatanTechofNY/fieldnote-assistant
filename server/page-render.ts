/**
 * Server-rendered HTML for hosted pages. No script runs on a page: polls and
 * checklists are plain forms that post and redirect back, and every chart is
 * inline SVG. The response carries a CSP that would refuse a script anyway.
 *
 * Every string that came from a person, the agent, or a todo goes through
 * `escapeHtml`; a URL only reaches an `href` or `src` through `safeHttpUrl`.
 */
import QRCode from "qrcode";
import { userTimezone } from "./db.ts";
import { escapeHtml as e, safeHttpUrl } from "./html.ts";
import { localParts } from "./local-time.ts";
import { pageCalendar } from "./page-ics.ts";
import {
  checklistItems, habitRows, liveTodos, moodSeries, progressOf, rotationStreak, rotationWeeks, type LiveTodo,
} from "./page-live.ts";
import {
  blockOptions, pageBlocks, pageIsLive, pollIsClosed, pollResults, tryPublicPageUrl, voteNameSuggestions,
  type BlockResults, type PageBlock, type PageRow,
} from "./pages.ts";
import type { Db } from "./types.ts";

export type RenderContext = {
  /** A signed-in owner is looking: owner pages open, results are always visible. */
  viewerIsOwner: boolean;
  /** The name remembered for this browser, to prefill the form and mark the viewer's own votes. */
  voterName?: string;
  /** A short, fixed notice from a redirect: `voted`, or an error code. */
  notice?: { kind: "ok" | "error"; text: string };
};

const CSS = `
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#1d2320;--muted:#667069;--line:#e3e0d7;--accent:#1f6f5c;--accent-ink:#fff;--soft:#e4f1ec;--warn:#a1472c;--m1:#d96b5a;--m2:#e6a15a;--m3:#e5cf6a;--m4:#a6cf7a;--m5:#4fae7b}
@media (prefers-color-scheme:dark){:root{--bg:#121614;--card:#1b211e;--ink:#eef2ef;--muted:#9aa59e;--line:#2b332f;--accent:#58c4a5;--accent-ink:#0c1512;--soft:#203029;--warn:#f0a58b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px 56px}
header{margin-bottom:18px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}
h1{font-size:28px;line-height:1.15;margin:6px 0 4px;letter-spacing:-.02em}
.meta{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:12px 0}
.card h2{font-size:17px;margin:0 0 10px;letter-spacing:-.01em}
p{margin:0 0 10px}p:last-child{margin-bottom:0}
a{color:var(--accent)}
ul.list,ol.list{list-style:none;margin:0;padding:0}
ul.list li{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid var(--line)}
ul.list li:first-child{border-top:0}
ul.list small,.small{display:block;color:var(--muted);font-size:13px}
.dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:7px;background:var(--line)}
.dot.in_progress{background:var(--m3)}.dot.blocked{background:var(--m1)}.dot.done{background:var(--m5)}.dot.pending{background:var(--muted)}
li.is-done strong{text-decoration:line-through;color:var(--muted)}
.empty{color:var(--muted);font-size:14px;padding:4px 0}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--soft);color:var(--accent);margin-left:6px;font-weight:600}
.pill.warn{background:transparent;border:1px solid var(--warn);color:var(--warn)}
.notice{border-radius:12px;padding:10px 14px;margin:12px 0;font-size:14px;background:var(--soft);color:var(--accent);font-weight:600}
.notice.error{background:transparent;border:1px solid var(--warn);color:var(--warn)}
label.opt{display:block;position:relative;border:1px solid var(--line);border-radius:12px;padding:11px 14px;margin:8px 0;overflow:hidden;cursor:pointer}
label.opt input{margin-right:10px;accent-color:var(--accent)}
label.opt .bar{position:absolute;inset:0 auto 0 0;background:var(--soft);z-index:0}
label.opt>*:not(.bar){position:relative;z-index:1}
label.opt .count{float:right;color:var(--muted);font-variant-numeric:tabular-nums}
label.opt.lead{border-color:var(--accent)}
.who{display:block;color:var(--muted);font-size:12.5px;margin:2px 0 0 26px}
.field{display:block;margin:12px 0 8px;font-size:14px;color:var(--muted)}
input[type=text]{width:100%;font:inherit;padding:11px 12px;margin-top:4px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink)}
button{font:inherit;font-weight:700;border:0;border-radius:12px;padding:11px 18px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line);padding:5px 11px;font-size:13px;font-weight:600}
button.tick{width:24px;height:24px;padding:0;border-radius:7px;border:2px solid var(--muted);background:transparent;color:var(--accent-ink);font-size:14px;line-height:1;flex:none;margin-top:2px}
button.tick.on{background:var(--accent);border-color:var(--accent)}
.rowform{display:flex;gap:10px;align-items:flex-start;margin:0;flex:1}
.rowform .grow{flex:1}
.grid{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed;font-size:13px}
.grid th{font-weight:600;color:var(--muted);text-align:center;padding:2px}
.grid th.day{text-align:left;width:34%;color:var(--ink)}
.grid td{padding:0}
.grid label{display:flex;align-items:center;justify-content:center;gap:4px;height:42px;border-radius:9px;border:1px solid var(--line);cursor:pointer;font-variant-numeric:tabular-nums}
.grid input{accent-color:var(--accent)}
.grid .h1{background:color-mix(in srgb,var(--accent) 16%,transparent)}.grid .h2{background:color-mix(in srgb,var(--accent) 32%,transparent)}
.grid .h3{background:color-mix(in srgb,var(--accent) 50%,transparent)}.grid .h4,.grid .h5{background:color-mix(in srgb,var(--accent) 70%,transparent)}
.grid .best{outline:2px solid var(--accent)}
.progress{height:10px;border-radius:99px;background:var(--line);overflow:hidden;margin:6px 0 10px}
.progress i{display:block;height:100%;background:var(--accent)}
.big{font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:12px;padding:12px}.tile b{display:block;font-size:24px;letter-spacing:-.02em}.tile span{color:var(--muted);font-size:13px}
.timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--line)}
.timeline li{position:relative;padding:4px 0 12px 14px}.timeline li::before{content:"";position:absolute;left:-21px;top:11px;width:10px;height:10px;border-radius:50%;background:var(--accent)}
.timeline b{display:block;color:var(--accent);font-size:13px}
.days{display:flex;gap:3px;flex-wrap:wrap;margin-top:6px}.days i{width:14px;height:14px;border-radius:4px;background:var(--line)}.days i.on{background:var(--accent)}
.heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,14px);gap:3px;overflow-x:auto;padding-bottom:4px}
.heat i{width:14px;height:14px;border-radius:4px;background:var(--line)}
.m1{background:var(--m1)!important}.m2{background:var(--m2)!important}.m3{background:var(--m3)!important}.m4{background:var(--m4)!important}.m5{background:var(--m5)!important}
svg.chart{width:100%;height:auto;display:block}
footer{margin-top:26px;text-align:center;color:var(--muted);font-size:13px}
.qr{display:inline-block;width:132px;background:#fff;padding:6px;border-radius:10px;margin:8px 0}.qr svg{display:block;width:100%;height:auto}
.rot td,.rot th{padding:6px 0;border-top:1px solid var(--line);text-align:left;font-size:15px}.rot table{width:100%;border-collapse:collapse}
.rot tr.now td{font-weight:700;color:var(--accent)}
img.pic{max-width:100%;border-radius:12px;display:block}
`;

const NOTICES: Record<string, { kind: "ok" | "error"; text: string }> = {
  voted: { kind: "ok", text: "Thanks, your answer is in. You can change it any time before the poll closes." },
  checked: { kind: "ok", text: "Updated." },
  name: { kind: "error", text: "Enter your name first so the others can see who answered." },
  closed: { kind: "error", text: "This poll has closed." },
  option: { kind: "error", text: "Pick an option first." },
  gone: { kind: "error", text: "That is no longer on this page." },
  slow: { kind: "error", text: "Too many tries. Wait a few minutes and try again." },
};
export const noticeFor = (code: unknown): RenderContext["notice"] => (typeof code === "string" ? NOTICES[code] : undefined);

/* Text --------------------------------------------------------------------- */

/** Paragraphs, `- ` bullets, **bold**, and bare links; everything else is shown as typed. */
export function richText(text: string): string {
  const inline = (line: string): string => e(line)
    .replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>")
    .replace(/https:\/\/[^\s<]{1,500}/g, match => {
      const trailing = /[.,;:!?)]+$/.exec(match)?.[0] ?? "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      const safe = safeHttpUrl(url.replaceAll("&amp;", "&"));
      return safe ? `<a href="${e(safe)}" rel="noopener noreferrer nofollow">${url}</a>${trailing}` : match;
    });
  return text.split(/\n{2,}/).map(paragraph => {
    const lines = paragraph.split("\n");
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
      return `<ul class="list">${lines.map(line => `<li><span class="dot"></span><div>${inline(line.replace(/^\s*[-*]\s+/, ""))}</div></li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

function dayLabel(iso: string | null, timezone: string, withTime = true): string {
  if (!iso) return "";
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(date);
  const parts = localParts(date, timezone);
  if (!withTime || parts.time === "00:00") return day;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} · ${time}`;
}

/** "America/New_York" reads as "New York time". */
export const timezoneName = (timezone: string): string =>
  `${(timezone.split("/").pop() ?? timezone).replaceAll("_", " ")} time`;

/* Blocks ------------------------------------------------------------------- */

const todoLine = (todo: LiveTodo, timezone: string): string => {
  const facts = [todo.due_at ? dayLabel(todo.due_at, timezone) : null, todo.priority && todo.priority !== "normal" ? todo.priority : null]
    .filter(Boolean).join(" · ");
  return `<li class="${todo.status === "done" ? "is-done" : ""}"><span class="dot ${e(todo.status)}"></span><div><strong>${e(todo.title)}</strong>${facts ? `<small>${e(facts)}</small>` : ""}</div></li>`;
};

const RANGE_TITLE = { today: "Due today", week: "This week", overdue: "Overdue", done_week: "Finished this week" } as const;
const RANGE_EMPTY = {
  today: "Nothing is due today.", week: "Nothing else is due this week.",
  overdue: "Nothing is overdue.", done_week: "Nothing finished yet this week.",
} as const;

const unavailable = (): string => `<section class="card"><p class="empty">This section is not available on this page.</p></section>`;

function renderTodos(db: Db, page: PageRow, block: PageBlock, timezone: string): string {
  const range = block.range ?? "today";
  const todos = liveTodos(db, page, range);
  const heading = block.text || RANGE_TITLE[range];
  return `<section class="card"><h2>${e(heading)}${todos.length ? `<span class="pill">${todos.length}</span>` : ""}</h2>${
    todos.length ? `<ul class="list">${todos.map(todo => todoLine(todo, timezone)).join("")}</ul>` : `<p class="empty">${RANGE_EMPTY[range]}</p>`
  }</section>`;
}

function renderPoll(
  page: PageRow, block: PageBlock, result: BlockResults, ctx: RenderContext, mine: Set<string>, suggestions: string[],
  timezone: string,
): string {
  const closed = pollIsClosed(block);
  const total = result.voters.length;
  const answered = Boolean(ctx.voterName && result.voters.some(name => name.toLowerCase() === ctx.voterName?.toLowerCase()));
  const showResults = closed || ctx.viewerIsOwner || answered;
  const multi = block.multi === true;
  const best = Math.max(0, ...result.options.map(option => option.count));
  const options = result.options.map(option => {
    const share = total ? Math.round((option.count / total) * 100) : 0;
    const control = closed ? "" : `<input type="${multi ? "checkbox" : "radio"}" name="option" value="${e(option.id)}"${mine.has(option.id) ? " checked" : ""}>`;
    return `<label class="opt${showResults && best && option.count === best ? " lead" : ""}">${showResults ? `<span class="bar" style="width:${share}%"></span>` : ""}${control}${e(option.label)}${showResults ? `<span class="count">${option.count}</span>` : ""}${showResults && option.voters.length ? `<span class="who">${e(option.voters.join(", "))}</span>` : ""}</label>`;
  }).join("");
  const status = closed
    ? `<span class="pill warn">Closed</span>`
    : block.closes_at ? `<span class="pill">Closes ${e(dayLabel(block.closes_at, timezone))}</span>` : "";
  const form = closed ? options : `<form method="post" action="/p/${e(page.slug)}/vote">
<input type="hidden" name="block" value="${e(block.id ?? "")}">${options}
${nameField(suggestions, ctx, block.id ?? "")}
<button type="submit">${answered ? "Update my answer" : "Vote"}</button></form>`;
  return `<section class="card"><h2>${e(block.text ?? "")} ${status}</h2>${form}${showResults ? `<p class="small">${total} ${total === 1 ? "person has" : "people have"} answered.</p>` : `<p class="small">Results appear once you have answered.</p>`}</section>`;
}

function nameField(suggestions: string[], ctx: RenderContext, blockId: string): string {
  const listId = `names-${blockId}`;
  return `<label class="field">Your name<input type="text" name="name" maxlength="40" autocomplete="given-name" required value="${e(ctx.voterName ?? "")}" ${suggestions.length ? `list="${e(listId)}"` : ""}></label>${
    suggestions.length ? `<datalist id="${e(listId)}">${suggestions.map(name => `<option value="${e(name)}"></option>`).join("")}</datalist>` : ""
  }`;
}

function renderAvailability(
  page: PageRow, block: PageBlock, result: BlockResults, ctx: RenderContext, mine: Set<string>, suggestions: string[],
  timezone: string,
): string {
  const closed = pollIsClosed(block);
  const total = result.voters.length;
  const answered = Boolean(ctx.voterName && result.voters.some(name => name.toLowerCase() === ctx.voterName?.toLowerCase()));
  const showResults = closed || ctx.viewerIsOwner || answered;
  const options = new Map(blockOptions(block).map(option => [option.id, result.options.find(entry => entry.id === option.id)]));
  const best = Math.max(0, ...result.options.map(option => option.count));
  const days = block.items ?? [];
  const slots = block.slots ?? [];
  const cell = (day: string, slot: string | null): string => {
    const id = [...options.keys()][slots.length ? days.indexOf(day) * slots.length + slots.indexOf(slot as string) : days.indexOf(day)];
    const info = options.get(id);
    const count = info?.count ?? 0;
    const heat = showResults && total ? Math.min(5, Math.ceil((count / total) * 5)) : 0;
    const lead = showResults && best > 0 && count === best;
    const control = closed ? "" : `<input type="checkbox" name="option" value="${e(id)}"${mine.has(id) ? " checked" : ""} aria-label="${e(`${day} ${slot ?? ""}`)}">`;
    return `<td><label class="${heat ? `h${heat}` : ""}${lead ? " best" : ""}" title="${e(info?.voters.join(", ") ?? "")}">${control}${showResults ? `<span>${count}</span>` : ""}</label></td>`;
  };
  const head = slots.length ? `<tr><th></th>${slots.map(slot => `<th>${e(slot)}</th>`).join("")}</tr>` : "";
  const rows = days.map(day => `<tr><th class="day">${e(day)}</th>${slots.length ? slots.map(slot => cell(day, slot)).join("") : cell(day, null)}</tr>`).join("");
  const table = `<table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  const status = closed ? `<span class="pill warn">Closed</span>` : block.closes_at ? `<span class="pill">Closes ${e(dayLabel(block.closes_at, timezone))}</span>` : "";
  const leaders = showResults && best ? `<p class="small">Best so far: <strong>${e(result.leaders.join(" or "))}</strong> (${best} of ${total}).</p>` : "";
  const body = closed ? table : `<form method="post" action="/p/${e(page.slug)}/vote"><input type="hidden" name="block" value="${e(block.id ?? "")}">${table}${nameField(suggestions, ctx, block.id ?? "")}<p class="small">Tick every slot that works for you.</p><button type="submit">${answered ? "Update my times" : "Send my times"}</button></form>`;
  return `<section class="card"><h2>${e(block.text || "When can you make it?")} ${status}</h2>${body}${leaders}</section>`;
}

function renderChecklist(db: Db, page: PageRow, block: PageBlock, ctx: RenderContext): string {
  const data = checklistItems(db, page, block);
  if (!data) return unavailable();
  const row = (item: (typeof data.items)[number]): string => {
    const done = item.status === "done";
    return `<li class="${done ? "is-done" : ""}"><form class="rowform" method="post" action="/p/${e(page.slug)}/check">
<input type="hidden" name="block" value="${e(block.id ?? "")}"><input type="hidden" name="todo" value="${e(item.id)}">
<input type="hidden" name="name" value="${e(ctx.voterName ?? "")}">
<button class="tick${done ? " on" : ""}" name="action" value="toggle" aria-label="${done ? "Mark not done" : "Mark done"}">${done ? "✓" : ""}</button>
<div class="grow"><strong>${e(item.title)}</strong>${item.claimed_by ? `<small>${e(item.claimed_by)} has this</small>` : ""}</div>
${!done && !item.claimed_by ? `<button class="ghost" name="action" value="claim">I'll take it</button>` : ""}</form></li>`;
  };
  const remaining = data.items.filter(item => item.status !== "done").length;
  const nameNote = ctx.voterName
    ? `<p class="small">Acting as ${e(ctx.voterName)}.</p>`
    : `<form method="post" action="/p/${e(page.slug)}/name"><label class="field">Your name, so the others can see who ticked what<input type="text" name="name" maxlength="40" required></label><button type="submit">Continue</button></form>`;
  return `<section class="card"><h2>${e(data.title)}<span class="pill">${remaining} left</span></h2>${
    data.items.length ? `<ul class="list">${data.items.map(row).join("")}</ul>` : `<p class="empty">Nothing on the list yet.</p>`
  }${nameNote}</section>`;
}

function renderProgress(db: Db, page: PageRow, block: PageBlock, timezone: string): string {
  const data = progressOf(db, page, block);
  if (!data) return unavailable();
  const percent = data.total ? Math.round((data.done / data.total) * 100) : 0;
  return `<section class="card"><h2>${e(data.title)}</h2><div class="big">${percent}%</div><div class="progress"><i style="width:${percent}%"></i></div>
<p class="small">${data.done} of ${data.total} steps done</p>${data.notes ? richText(data.notes) : ""}
${data.open.length ? `<ul class="list">${data.open.map(todo => todoLine(todo, timezone)).join("")}</ul>` : ""}</section>`;
}

function renderHabits(db: Db, page: PageRow): string {
  const habits = habitRows(db, page);
  if (!habits.length) return `<section class="card"><h2>Habits</h2><p class="empty">No repeating todos yet.</p></section>`;
  return `<section class="card"><h2>Habits</h2><ul class="list">${habits.map(habit => `<li><div class="grow" style="flex:1"><strong>${e(habit.title)}</strong><small>${habit.streak ? `${habit.streak} in a row` : "No streak yet"} · ${habit.count} done in all</small><div class="days" aria-hidden="true">${habit.days.map(on => `<i class="${on ? "on" : ""}"></i>`).join("")}</div></div></li>`).join("")}</ul></section>`;
}

function renderMoodChart(db: Db, page: PageRow, block: PageBlock): string {
  const span = block.days ?? 30;
  const series = moodSeries(db, page, span);
  if (!series.days.length) return `<section class="card"><h2>${e(block.text || "Mood")}</h2><p class="empty">No moods recorded in this period.</p></section>`;
  const width = 600;
  const height = 160;
  const start = Date.now() - span * 86_400_000;
  const x = (date: string) => 14 + ((Date.parse(`${date}T12:00:00Z`) - start) / (span * 86_400_000)) * (width - 28);
  const y = (score: number) => height - 14 - ((score - 1) / 4) * (height - 28);
  const points = series.days.map(day => `${x(day.date).toFixed(1)},${y(day.score).toFixed(1)}`);
  const guides = [1, 3, 5].map(score => `<line x1="14" x2="${width - 14}" y1="${y(score)}" y2="${y(score)}" stroke="currentColor" opacity=".12"/>`).join("");
  const dots = series.days.map(day => `<circle cx="${x(day.date).toFixed(1)}" cy="${y(day.score).toFixed(1)}" r="3.5" fill="var(--accent)"/>`).join("");
  const people = series.people.length
    ? `<ul class="list">${series.people.map(person => `<li><div><strong>${e(person.name)}</strong><small>${person.average} average over ${person.entries} ${person.entries === 1 ? "entry" : "entries"}</small></div></li>`).join("")}</ul>` : "";
  return `<section class="card"><h2>${e(block.text || "Mood")}<span class="pill">${series.average} avg</span></h2>
<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mood over the last ${span} days">${guides}<polyline fill="none" stroke="var(--accent)" stroke-width="2.5" points="${points.join(" ")}"/>${dots}</svg>${people}</section>`;
}

function renderMoodHeatmap(db: Db, page: PageRow, block: PageBlock, timezone: string): string {
  const span = block.days ?? 90;
  const series = moodSeries(db, page, span);
  const scores = new Map(series.days.map(day => [day.date, Math.round(day.score)]));
  const today = new Date();
  const cells: string[] = [];
  const first = new Date(today.getTime() - (span - 1) * 86_400_000);
  // Pad to a Monday-first column so each column is one week.
  const lead = (new Date(`${localParts(first, timezone).date}T12:00:00Z`).getUTCDay() + 6) % 7;
  for (let i = 0; i < lead; i += 1) cells.push(`<i style="visibility:hidden"></i>`);
  for (let step = 0; step < span; step += 1) {
    const date = localParts(new Date(first.getTime() + step * 86_400_000), timezone).date;
    const score = scores.get(date);
    cells.push(`<i class="${score ? `m${score}` : ""}" title="${e(date)}${score ? ` · ${score}/5` : ""}"></i>`);
  }
  const best = [...series.days].sort((a, b) => b.score - a.score)[0];
  return `<section class="card"><h2>${e(block.text || "Mood heatmap")}${series.average ? `<span class="pill">${series.average} avg</span>` : ""}</h2><div class="heat" role="img" aria-label="Daily mood">${cells.join("")}</div>
<p class="small">${series.days.length ? `${series.days.length} days recorded${best ? `. Best day: ${e(dayLabel(`${best.date}T12:00:00Z`, "UTC", false))} (${best.score}).` : "."}` : "No moods recorded in this period."}</p></section>`;
}

function renderRotation(db: Db, page: PageRow, block: PageBlock): string {
  const weeks = rotationWeeks(db, page, block);
  const streak = rotationStreak(db, page, block);
  return `<section class="card rot"><h2>${e(block.text ?? "Rotation")}${streak ? `<span class="pill">${streak} in a row</span>` : ""}</h2><table><tbody>${weeks.map(week => `<tr class="${week.current ? "now" : ""}"><th>${week.current ? "This week" : `Week of ${e(week.start.slice(5))}`}</th><td>${e(week.name)}</td></tr>`).join("")}</tbody></table></section>`;
}

function renderCountdown(block: PageBlock, timezone: string): string {
  const target = Date.parse(block.when as string);
  const ms = target - Date.now();
  const days = Math.floor(Math.abs(ms) / 86_400_000);
  const hours = Math.floor((Math.abs(ms) % 86_400_000) / 3_600_000);
  const text = ms > 0 ? (days ? `${days} ${days === 1 ? "day" : "days"}${days < 3 ? `, ${hours}h` : ""}` : `${hours}h`) : "It has begun";
  return `<section class="card"><div class="small">${e(block.text ?? "")}</div><div class="big">${e(text)}</div><p class="small">${e(dayLabel(block.when as string, timezone))}</p></section>`;
}

function renderItinerary(block: PageBlock): string {
  return `<section class="card"><h2>${e(block.text || "Plan")}</h2><ul class="timeline">${(block.items ?? []).map(item => {
    const [when, ...rest] = item.split("|");
    return rest.length ? `<li><b>${e(when.trim())}</b>${e(rest.join("|").trim())}</li>` : `<li>${e(item)}</li>`;
  }).join("")}</ul></section>`;
}

function renderStats(block: PageBlock): string {
  return `<section class="card">${block.text ? `<h2>${e(block.text)}</h2>` : ""}<div class="tiles">${(block.items ?? []).map(item => {
    const [label, ...value] = item.split("|");
    return `<div class="tile"><b>${e(value.join("|").trim() || "–")}</b><span>${e(label.trim())}</span></div>`;
  }).join("")}</div></section>`;
}

function renderBlock(db: Db, page: PageRow, block: PageBlock, ctx: RenderContext, timezone: string, results: BlockResults[], mine: Map<string, Set<string>>, suggestions: string[]): string {
  switch (block.type) {
    case "heading": return `<h2 style="margin:22px 4px 0;font-size:20px">${e(block.text ?? "")}</h2>`;
    case "text": return `<section class="card">${richText(block.text ?? "")}</section>`;
    case "checklist": return `<section class="card"><ul class="list">${(block.items ?? []).map(item => `<li><span class="dot"></span><div>${e(item)}</div></li>`).join("")}</ul></section>`;
    case "link": {
      const url = safeHttpUrl(block.url);
      return url ? `<section class="card"><a href="${e(url)}" rel="noopener noreferrer nofollow"><strong>${e(block.text || new URL(url).hostname)}</strong></a><small class="small">${e(new URL(url).hostname)}</small></section>` : "";
    }
    case "image": {
      const url = safeHttpUrl(block.url);
      return url ? `<section class="card"><img class="pic" src="${e(url)}" alt="${e(block.text ?? "")}" loading="lazy" referrerpolicy="no-referrer">${block.text ? `<p class="small">${e(block.text)}</p>` : ""}</section>` : "";
    }
    case "todos": return renderTodos(db, page, block, timezone);
    case "poll": {
      const result = results.find(entry => entry.block_id === block.id);
      return result ? renderPoll(page, block, result, ctx, mine.get(block.id ?? "") ?? new Set(), suggestions, timezone) : "";
    }
    case "availability": {
      const result = results.find(entry => entry.block_id === block.id);
      return result ? renderAvailability(page, block, result, ctx, mine.get(block.id ?? "") ?? new Set(), suggestions, timezone) : "";
    }
    case "live_checklist": return renderChecklist(db, page, block, ctx);
    case "progress": return renderProgress(db, page, block, timezone);
    case "countdown": return renderCountdown(block, timezone);
    case "itinerary": return renderItinerary(block);
    case "stats": return renderStats(block);
    case "habits": return renderHabits(db, page);
    case "rotation": return renderRotation(db, page, block);
    case "mood_chart": return renderMoodChart(db, page, block);
    case "mood_heatmap": return renderMoodHeatmap(db, page, block, timezone);
    default: return "";
  }
}

/* Page --------------------------------------------------------------------- */

const LIVE_BLOCKS = new Set(["todos", "live_checklist", "progress", "habits", "rotation", "mood_chart", "mood_heatmap"]);

function description(blocks: PageBlock[], page: PageRow): string {
  const poll = blocks.find(block => block.type === "poll" || block.type === "availability");
  if (poll) return poll.text || "Add your vote";
  const text = blocks.find(block => block.type === "text");
  return text?.text?.slice(0, 160) || `${page.title}: shared from Fieldnote`;
}

export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
}

export async function renderPage(db: Db, page: PageRow, ctx: RenderContext): Promise<string> {
  const timezone = userTimezone(db);
  const blocks = pageBlocks(page);
  const live = blocks.some(block => LIVE_BLOCKS.has(block.type));
  const results = pollResults(db, page);
  const mine = new Map<string, Set<string>>();
  if (ctx.voterName) {
    const key = ctx.voterName.trim().toLowerCase();
    const rows = db.prepare("SELECT block_id,option_ids_json FROM page_votes WHERE page_id=? AND voter_name_key=?")
      .all(page.id, key) as Array<{ block_id: string; option_ids_json: string }>;
    for (const row of rows) mine.set(row.block_id, new Set(JSON.parse(row.option_ids_json) as string[]));
  }
  const suggestions = voteNameSuggestions(db, page);
  const now = new Date();
  const dateLine = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(now);
  const meta = page.kind === "today"
    ? `Today, ${dateLine} (${timezoneName(timezone)})`
    : page.kind === "week" ? `Week of ${dateLine} (${timezoneName(timezone)})`
      : live ? `As of ${dateLine} (${timezoneName(timezone)})` : "";
  const url = tryPublicPageUrl(db, page.slug);
  const notice = ctx.notice ? `<div class="notice ${ctx.notice.kind}" role="status">${e(ctx.notice.text)}</div>` : "";
  const body = blocks.map(block => renderBlock(db, page, block, ctx, timezone, results, mine, suggestions)).join("\n");
  const calendar = pageCalendar(db, page) ? `<p><a href="/p/${e(page.slug)}/event.ics">Add to calendar</a></p>` : "";
  const qr = page.audience === "shared" && url ? `<div class="qr" aria-label="QR code for this page">${await qrSvg(url)}</div>` : "";
  const owner = page.audience === "owner" ? `<span class="pill warn">Private</span>` : "";
  const og = url ? new URL("/p/og.png", url).toString() : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${e(page.title)}</title>
<meta property="og:title" content="${e(page.title)}">
<meta property="og:description" content="${e(description(blocks, page))}">
<meta property="og:site_name" content="Fieldnote">
<meta property="og:type" content="website">
${og ? `<meta property="og:image" content="${e(og)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<style>${CSS}</style></head>
<body><main>
<header><div class="eyebrow">Fieldnote${owner}</div><h1>${e(page.title)}</h1>${meta ? `<div class="meta">${e(meta)}</div>` : ""}</header>
${notice}
${body}
<footer>${calendar}${qr ? `<div>${qr}</div>` : ""}<div>${pageIsLive(page) ? `Open until ${e(dayLabel(page.expires_at, timezone, false))}` : "This page has expired"}</div></footer>
</main></body></html>`;
}

export function renderUnavailable(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not available</title><style>${CSS}</style></head><body><main><header><div class="eyebrow">Fieldnote</div><h1>This page isn&rsquo;t available</h1><p class="meta">The link may have expired or been turned off by whoever shared it.</p></header></main></body></html>`;
}
