/**
 * The browser has to name its own Agent Studio conversation. Left alone, the
 * chat widget invents an id per mount, so a single afternoon produced dozens of
 * one-question conversations in Agent Studio and not one of them could be matched
 * to a thread in our archive — the id we stored, `browser-agent`, was never sent
 * to Algolia at all.
 *
 * The id is retired once the session has been idle past the same window the SMS
 * runner uses, so a conversation covers one sitting instead of every sitting.
 */
const STORAGE_KEY = "fieldnote.agent-conversation";
const IDLE_LIMIT_MS = 24 * 60 * 60_000;

type StoredConversation = { id: string; lastActivityAt: number };

function newId(): string {
  return `alg_cnv_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Private browsing and a disabled store both throw rather than return null. */
function read(): StoredConversation | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConversation;
    return typeof parsed?.id === "string" && typeof parsed?.lastActivityAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function write(value: StoredConversation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A conversation the browser cannot remember is still usable for this session.
  }
}

/**
 * Resolve once per mount and hold the result: the widget compares props by
 * value, and an id that changed between renders would rebuild the chat and drop
 * the conversation it was naming.
 */
export function resolveAgentConversationId(): string {
  const stored = read();
  if (stored && Date.now() - stored.lastActivityAt < IDLE_LIMIT_MS) {
    return stored.id;
  }
  const id = newId();
  write({ id, lastActivityAt: Date.now() });
  return id;
}

/** Called when a turn finishes so a session in use never ages out mid-sitting. */
export function touchAgentConversation(id: string): void {
  write({ id, lastActivityAt: Date.now() });
}
