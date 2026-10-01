/*
 * Soul and profile text is rewritten by the model and edited by people, and
 * both tend to say the same thing twice: the agent merges a new rule into the
 * Soul without noticing it is already there, and a profile rewrite repeats a
 * phrase under two parts. These keep the first of each before anything is
 * saved. They only catch the same words, ignoring case, bullets, spacing, and
 * trailing punctuation; a rule said in other words is not recognised.
 */

/** What makes two lines or phrases "the same": case, bullet marks, spacing, and trailing punctuation do not. */
function sameness(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:[-*•–—]+|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();
}

/** A Soul: one rule per line. Repeats of a rule are dropped, the first kept; blank lines stay as they are. */
export function dedupeLines(text: string): string {
  const seen = new Set<string>();
  const kept = text.split("\n").filter(line => {
    const key = sameness(line);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Dropping a line between two blank ones must not leave a gap of several.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A "Label: phrase; phrase" line; a line without a label is all phrases. */
const LABELLED = /^(\s*[^:;\n]{1,60}:\s*)(.*)$/;

/**
 * A profile: short labelled lines of phrases separated by semicolons. A phrase
 * is dropped when the same label already said it, in this line or an earlier
 * one; the same phrase under a different label is a different statement. A
 * line left with nothing to say is dropped.
 */
export function dedupePhrases(text: string): string {
  const seen = new Set<string>();
  const lines = text.split("\n").flatMap(line => {
    const match = LABELLED.exec(line);
    const label = match?.[1] ?? "";
    const body = match ? match[2] : line;
    const phrases = body.split(";").map(phrase => phrase.trim()).filter(Boolean);
    if (!phrases.length) return [line];
    const scope = sameness(label);
    const fresh = phrases.filter(phrase => {
      const key = `${scope}|${sameness(phrase)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return fresh.length ? [`${label}${fresh.join("; ")}`.trimEnd()] : [];
  });
  return lines.join("\n").trim();
}
