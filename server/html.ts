/**
 * Escaping for every string that is put into server-rendered HTML: the sign-in
 * page and the hosted pages. Nothing else on the server writes markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string
  ));
}

/** A URL is only ever written into an `href` or `src` as http(s); anything else becomes a dead anchor. */
export function safeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
