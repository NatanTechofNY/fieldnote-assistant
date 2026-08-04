/**
 * Query terms are matched here rather than taken from Algolia's own highlight
 * payload, because the same treatment has to work for the SQLite fallback and
 * for the canonical message body, which search never returns.
 */

/**
 * Words too common to be worth marking. A query only loses them when something
 * else survives, so searching for "the" still marks "the".
 */
const NOISE_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "was", "were", "are", "you", "your",
  "did", "does", "have", "has", "had", "about", "what", "when", "where", "who", "why", "how", "all",
  "any", "can", "not", "but", "our", "its", "his", "her", "she", "him", "they", "them", "there",
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * How long a snippet may run before it is re-centred. A result row clamps to two
 * lines, so anything much past this is cut by the layout anyway.
 */
const SNIPPET_LENGTH = 120;

export function searchTerms(query: string): string[] {
  const words = (query.toLowerCase().match(WORD) ?? []).filter(word => word.length > 1);
  const meaningful = words.filter(word => !NOISE_WORDS.has(word));
  // Longest first, so overlapping terms mark the longer of the two.
  return [...new Set(meaningful.length ? meaningful : words)].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termsPattern(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
}

export type TextPart = { value: string; match: boolean };

/** Splits text into alternating plain and matching runs, in reading order. */
export function splitByTerms(text: string, terms: string[]): TextPart[] {
  const pattern = termsPattern(terms);
  if (!pattern || !text) return [{ value: text, match: false }];
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (start > cursor) parts.push({ value: text.slice(cursor, start), match: false });
    parts.push({ value: found[0], match: true });
    cursor = start + found[0].length;
  }
  if (cursor < text.length) parts.push({ value: text.slice(cursor), match: false });
  return parts;
}

/**
 * A result row shows two lines, so a match four hundred characters in would be
 * clipped out of the very preview meant to justify it. This re-centres the
 * preview on the first match and marks whichever end it cut.
 */
export function snippetAround(text: string, terms: string[], length = SNIPPET_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= length) return collapsed;
  const at = termsPattern(terms)?.exec(collapsed)?.index ?? 0;
  const lead = Math.floor(length / 3);
  if (at <= lead) return `${collapsed.slice(0, length).trimEnd()}…`;
  const end = Math.min(collapsed.length, at - lead + length);
  // Starting mid-word reads as a typo rather than as a cut, so drop the stub.
  const body = collapsed.slice(at - lead, end).replace(/^\S+\s/, "").trimEnd();
  return `…${body}${end < collapsed.length ? "…" : ""}`;
}
