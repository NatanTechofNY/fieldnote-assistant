/**
 * Claims a reply makes that a tool call has to back.
 *
 * The prompt tells the assistant not to say "I'll save that" or "I'll text you
 * in ten minutes" without writing anything, and a past turn did both anyway.
 * The runner therefore reads the final reply for these claims and, when no
 * matching write happened in the turn, sends the model back once to do the
 * write or retract the claim.
 *
 * This is best effort in both directions. A phrase the patterns do not know
 * ("consider it done") is not caught, and a reply that happens to read like a
 * claim costs one extra model round, which the check message lets the model
 * dismiss. The patterns are tuned to miss rather than to nag.
 *
 * Everything here runs on the single worker, so the input is capped and the
 * reply is tested one sentence at a time instead of with patterns that
 * backtrack across the whole text.
 */

/** How much of a reply is read for claims; a longer one is a document, not a promise. */
export const MAX_CLAIM_SCAN = 4000;

/** `’` is what phones type, and what the model echoes: the patterns are written with `'`. */
export function straightQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc\u201b]/g, "'");
}

/** The sentences of a reply, with an offer or a question set aside: "want me to save it?" promises nothing. */
function sentences(text: string): string[] {
  return straightQuotes(text.slice(0, MAX_CLAIM_SCAN))
    .split(/(?<=[.!?])[ \t]+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !sentence.endsWith("?") && !OFFER.test(sentence));
}

const OFFER = /\bi (?:can|could|would|should|might)\b|\bshould i\b|\bshall i\b|\bwant me to\b|\bwould you like\b|\bdo you want\b|\bif you(?:'d)? (?:like|want)\b|\blet me know if\b|\bi'd be happy\b/i;

/** What a reply that says it saved something is held to: a todo write backs "added it to your list", not "I'll remember that". */
const SAVE_VERBS = "save|log|remember|note|record|jot|add|store|file|write";
const SAVE_PAST = "saved|logged|noted|recorded|added|stored|filed|wrote|jotted";
const SAVE_OBJECT = "(?:it|that|this|these|those|them|the|your|today'?s|a|an|down|everything)";

const SAVE_CLAIMS = [
  // "I'll save this", "I've logged it": a first-person promise or report with something as its object,
  // so "I'll save you a seat" and "I remember the day" are not claims.
  new RegExp(`\\bi(?:'ll| will|'m going to| am going to)\\s+(?:go ahead and\\s+)?(?:${SAVE_VERBS})\\s+${SAVE_OBJECT}\\b`, "i"),
  new RegExp(`\\bi(?:'ve| have)?\\s+(?:just\\s+)?(?:${SAVE_PAST})\\s+${SAVE_OBJECT}\\b`, "i"),
  // "Saved.", "Got it, logged.": a bare confirmation. "Saved earlier" and "Saved items:" report what is already there.
  /^(?:(?:got it|done|okay|ok|sure|alright|yep|yes)[,.!\u2014\u2013-]*\s+)?(?:saved|logged|recorded|stored|filed)\b(?!\s*(?:earlier|already|yesterday|before|previously|items?|memories|notes|entries)\b)/i,
];

const REMINDER_PROMISE = new RegExp(
  [
    "\\bi(?:'ll| will|'m going to)\\s+(?:go ahead and\\s+)?(?:text|remind|ping|nudge|message|notify|shoot|check back with|follow up with)\\s+(?:you|y'all|ya|u|(?:both|all) of you|everyone|the group)\\b",
    "\\bi(?:'ll| will)\\s+(?:shoot|send)\\s+(?:you|y'all)\\s+a\\s+(?:text|reminder|nudge|message)\\b",
    "\\byou(?:'ll| will)\\s+(?:get|hear|see)\\s+(?:a\\s+)?(?:text|reminder|ping|nudge|message)\\b",
  ].join("|"),
  "i",
);

/** A promise to text is a claim only with a when: "I'll text you the link" is not one. */
const WHEN = /\b(?:in (?:\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty)\b|at \d|at (?:noon|midnight)|tomorrow|tonight|later|then|when it'?s time|before|after|this (?:morning|afternoon|evening)|next \w+|on (?:mon|tues|wednes|thurs|fri|satur|sun)|\d\s?(?:am|pm)|\d+:\d\d|(?:minutes?|hours?|days?)\b)/i;

const REMINDER_DONE = [
  /\b(?:reminder|alarm|timer)(?:\s+is|\s+has been|\s+are|'s)\s+(?:now\s+)?set\b/i,
  /\bi(?:'ve| have)?\s+(?:just\s+)?set\s+(?:a\s+|the\s+|your\s+)?(?:reminder|alarm|timer)\b/i,
  /\bi(?:'ve| have)?\s+(?:just\s+)?set\s+(?:it|that|this)\s+(?:for|to)\b/i,
];

/** Whether the reply says, as a claim about this turn, that something was or will be saved. */
export function claimsSave(reply: string): boolean {
  return sentences(reply).some(sentence => SAVE_CLAIMS.some(pattern => pattern.test(sentence)));
}

/** Whether the reply promises a text or reminder at a later time. */
export function claimsReminder(reply: string): boolean {
  return sentences(reply).some(sentence =>
    (REMINDER_PROMISE.test(sentence) && WHEN.test(sentence)) || REMINDER_DONE.some(pattern => pattern.test(sentence)));
}

/*
 * A reply that says a todo's time moved. "I'll treat it as tomorrow at 2 PM"
 * went out after the owner answered a reminder with "will do that tomorrow
 * around 2", from a turn that wrote nothing, and the todo kept its old due
 * time and was followed up on the next morning as overdue. Like the others
 * this needs a first-person report or promise, a move word, and a when.
 */
const DUE_WHEN = /\b(?:tomorrow|tonight|today|this (?:morning|afternoon|evening|week|weekend)|next \w+|(?:mon|tues|wednes|thurs|fri|satur|sun)day|noon|midnight|end of (?:the )?(?:day|week)|eod|at \d|\d\s?(?:am|pm)|\d+:\d\d|in (?:\d+|an?|one|two|three|four|five|six|seven|ten|a couple of|a few) (?:minutes?|hours?|days?|weeks?)|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d|\d{4}-\d\d-\d\d)\b/i;

const DUE_CLAIMS = [
  // "I'll treat X as tomorrow at 2", "I'll move it to Monday", "I'll push that to Friday".
  new RegExp(`\\bi(?:'ll| will|'m going to| am going to)\\s+(?:go ahead and\\s+)?(?:treat|count|move|push|bump|shift|reschedule)\\b(?!\\s+on\\b)[^.!?]{0,160}?\\b(?:as|to|for|until|at)\\b`, "i"),
  // "I moved X to Monday at 2:00 PM", "I've rescheduled it for tomorrow".
  new RegExp(`\\bi(?:'ve| have)?\\s+(?:just\\s+)?(?:moved|pushed|bumped|shifted|rescheduled)\\b(?!\\s+on\\b)[^.!?]{0,160}?\\b(?:to|for|until|at)\\b`, "i"),
  // "Moved to Monday.", "Got it, pushed to 2 PM."
  /^(?:(?:got it|done|okay|ok|sure|alright|yep|yes)[,.!\u2014\u2013-]*\s+)?(?:moved|pushed|bumped|rescheduled)\b[^.!?]{0,160}?\b(?:to|for|until|at)\b/i,
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed)\b[^.!?]{0,80}?\bdue (?:date|time)\b/i,
];

/** Whether the reply says, as a claim about this turn, that a todo's time was or will be changed. */
export function claimsDueChange(reply: string): boolean {
  return sentences(reply).some(sentence =>
    DUE_CLAIMS.some(pattern => pattern.test(sentence)) && (DUE_WHEN.test(sentence) || /\bdue (?:date|time)\b/i.test(sentence)));
}

export const DUE_CLAIM_CHECK = [
  "[runtime check, not from the user] Your reply says a todo's due time was or will be moved,",
  "but no todo write or reminder change succeeded in this turn, so its due time is unchanged.",
  "Call update_todo with the new due_at now (and move reminder_at if it sat on the old due time), then write your reply again.",
  "If you were only offering, ask instead of confirming. If you were not changing a time, answer again without the claim.",
].join(" ");

/** A reply about a todo or a list: a todo write backs its claim of "added", a memory write does not need to. */
const TODO_WORDS = /\b(?:todo|to-do|task|reminder|list|checklist|subtask|step|due)\b/i;

export function mentionsTodo(reply: string): boolean {
  return TODO_WORDS.test(reply.slice(0, MAX_CLAIM_SCAN));
}

export const SAVE_CLAIM_CHECK = [
  "[runtime check, not from the user] Your reply says something was saved or will be saved,",
  "but no create_memory, update_memory, or other write succeeded in this turn, so nothing was kept.",
  "Call the matching tool now, then write your reply again.",
  "If you were only offering, ask instead of confirming. If you were only reporting something saved earlier, say it was saved earlier and write nothing.",
  "If your reply was not about saving anything, answer again without the claim.",
].join(" ");

export const REMINDER_CLAIM_CHECK = [
  "[runtime check, not from the user] Your reply promises a text or reminder at a later time,",
  "but no reminder was created or changed in this turn, and nothing read in this turn showed one was already set, so nothing will be sent.",
  "Create the todo with reminder_at (or call create_reminder for a todo that exists) now, then write your reply again.",
  "If you were only offering, ask instead of promising. If you were not scheduling anything, answer again without the promise.",
].join(" ");

/** The writes that put a reminder on the calendar; a todo write counts only when it set one. */
export const REMINDER_WRITE_TOOLS = new Set(["create_reminder", "update_reminder"]);
const TODO_REMINDER_TOOLS = new Set(["create_todo", "update_todo"]);

/** The input fields of a todo write that schedule something. */
const SCHEDULING_FIELDS = ["reminder_at", "extra_reminders", "recurrence", "due_at"] as const;

function present(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/**
 * Whether a successful todo write set a reminder: the call asked for a
 * schedule and the todo that came back carries one. A rename of a todo that
 * already had a reminder is not a promise made in this turn.
 */
export function todoWriteSetsReminder(tool: string, input: unknown, data: unknown): boolean {
  if (!TODO_REMINDER_TOOLS.has(tool) || !input || typeof input !== "object" || !data || typeof data !== "object") return false;
  const sent = input as Record<string, unknown>;
  const fields = (tool === "update_todo" && sent.patch && typeof sent.patch === "object" ? sent.patch : sent) as Record<string, unknown>;
  if (!SCHEDULING_FIELDS.some(field => present(fields[field]))) return false;
  const record = data as { reminder_at?: unknown; extra_reminders?: unknown; recurrence?: unknown };
  return present(record.reminder_at) || present(record.extra_reminders) || present(record.recurrence);
}

/**
 * Whether a successful write moved a todo's time: a reminder call, or a todo
 * write that asked for a schedule and returned a todo that carries one.
 */
export function writeChangesDue(tool: string, input: unknown, data: unknown): boolean {
  if (REMINDER_WRITE_TOOLS.has(tool)) return true;
  if (!TODO_REMINDER_TOOLS.has(tool) || !input || typeof input !== "object" || !data || typeof data !== "object") return false;
  const sent = input as Record<string, unknown>;
  const fields = (tool === "update_todo" && sent.patch && typeof sent.patch === "object" ? sent.patch : sent) as Record<string, unknown>;
  if (!SCHEDULING_FIELDS.some(field => present(fields[field]))) return false;
  const record = data as { due_at?: unknown; reminder_at?: unknown; extra_reminders?: unknown; recurrence?: unknown };
  return present(record.due_at) || present(record.reminder_at) || present(record.extra_reminders) || present(record.recurrence);
}

/** Whether a read showed at least one reminder: an empty list backs nothing, so "I'll text you" after it is still unbacked. */
export function readShowsReminder(tool: string, data: unknown): boolean {
  if (tool === "list_reminders") return Array.isArray(data) && data.length > 0;
  if (tool === "get_agenda") {
    const reminders = (data as { reminders?: unknown } | null)?.reminders;
    return Array.isArray(reminders) && reminders.length > 0;
  }
  return false;
}
