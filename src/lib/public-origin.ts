/**
 * Where this page was served from. On a deployed install, or behind a tunnel,
 * that is exactly the origin a message provider has to call back, so it is
 * offered as the webhook base URL. A plain-HTTP origin — `http://localhost:4173`
 * in development — cannot receive webhooks and is not offered.
 */
export function currentPublicOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const { origin } = window.location;
  return origin.startsWith("https://") ? origin : null;
}
