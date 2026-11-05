import type { Request, Response } from "express";
import { authEnabled } from "../auth.ts";
import {
  authorizationServerMetadata, clientSecretOk, consentToken, consentTokenOk, exchangeCode, issueCode, oauthClient,
  OAuthError, protectedResourceMetadata, refreshTokens, validateAuthorizationRequest, type AuthorizationRequest,
} from "../alexa-oauth.ts";
import { escapeHtml } from "../html.ts";
import { slidingWindow } from "../rate-limit.ts";
import type { RouteContext } from "./context.ts";

/*
 * Account linking for Alexa+. Discovery and `/oauth/token` are public (Amazon
 * calls them without a session; the gate in `routes/auth.ts` lets them
 * through), and every one of them answers only for the one configured client.
 * `/oauth/authorize` is deliberately NOT exempt: it sits behind the sign-in
 * gate, so approving a link takes the owner's own session, and a visitor with
 * no session is sent to the login page and back.
 */

/*
 * Only refused token requests are counted. The caller is the socket peer, which behind a proxy is the proxy for
 * everyone, so a cap on all requests would let an anonymous caller spend it and stop Alexa from refreshing. A request
 * that succeeds is never throttled; a caller already over the limit just stops being told why the others failed.
 */
const TOKEN_FAILURES_PER_WINDOW = 60;
const WINDOW_MS = 10 * 60_000;
const tokenThrottle = slidingWindow(TOKEN_FAILURES_PER_WINDOW, WINDOW_MS);

/** For tests: forget every caller's recent token requests. */
export function resetOAuthThrottle(): void {
  tokenThrottle.clear();
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function pageHeaders(res: Response): void {
  noStore(res);
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function oauthFailure(res: Response, error: OAuthError): Response {
  noStore(res);
  return res.status(error.status).json({ error: error.error, error_description: error.message });
}

const PAGE_STYLE = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #ebe6d8; color: #192019;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 420px; background: #f6f2e8; border: 1px solid #d8d1bf; border-radius: 14px; padding: 32px; }
  h1 { margin: 0 0 8px; font-size: 1.3rem; } p { color: #4b514a; line-height: 1.5; font-size: .95rem; }
  .row { display: flex; gap: 10px; margin-top: 22px; }
  button { flex: 1; padding: 11px 14px; border: 0; border-radius: 9px; font-size: .95rem; font-weight: 600; cursor: pointer; }
  .allow { background: #192019; color: #f6f2e8; } .deny { background: #e4dfce; color: #192019; }`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} &middot; Fieldnote</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function errorPage(message: string): string {
  return shell("Link Alexa", `<h1>Could not link Alexa</h1><p>${escapeHtml(message)}</p>`);
}

function consentPage(request: AuthorizationRequest, scope: string): string {
  const token = consentToken(request);
  const hidden = (name: string, value: string | number) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}">`;
  return shell("Link Alexa", `
    <h1>Link Alexa to Household?</h1>
    <p>Alexa will be able to read and add to the <strong>Household</strong> area of Fieldnote: its tasks, reminders and agenda.
    It will not see your other records, your private chats, or anything from Jira and Confluence, and it cannot delete anything.
    You can unlink it at any time in Settings.</p>
    <form method="post" action="/oauth/authorize">
      ${hidden("client_id", request.clientId)}${hidden("redirect_uri", request.redirectUri)}${hidden("code_challenge", request.codeChallenge)}
      ${hidden("code_challenge_method", "S256")}${hidden("resource", request.resource)}${hidden("state", request.state)}${hidden("scope", scope)}
      ${hidden("response_type", "code")}${hidden("consent_expires", token.expires)}${hidden("consent_mac", token.mac)}
      <div class="row"><button class="deny" name="decision" value="deny" type="submit">Cancel</button>
      <button class="allow" name="decision" value="allow" type="submit">Link Alexa</button></div>
    </form>`);
}

function redirectWith(request: AuthorizationRequest, params: Record<string, string>): string {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (request.state) url.searchParams.set("state", request.state);
  return url.toString();
}

/** `client_secret_basic` or `client_secret_post`, whichever Amazon sends. */
function presentedClient(req: Request): { clientId: string | undefined; secret: string | undefined } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator !== -1) {
      // RFC 6749 form-encodes the pair before base64; a value that does not decode is just a wrong credential.
      const decode = (value: string): string => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      return { clientId: decode(decoded.slice(0, separator)), secret: decode(decoded.slice(separator + 1)) };
    }
  }
  return {
    clientId: typeof body.client_id === "string" ? body.client_id : undefined,
    secret: typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

export function registerAlexaOAuthRoutes({ app, db }: RouteContext): void {
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    const metadata = protectedResourceMetadata(db);
    if (!metadata || !oauthClient()) return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "no-store");
    return res.json(metadata);
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const metadata = authorizationServerMetadata(db);
    if (!metadata || !oauthClient()) return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "no-store");
    return res.json(metadata);
  });

  /** The consent step is the owner's to take: without a password anyone could approve a link, so none is offered. */
  const refuseWithoutPassword = (res: Response): boolean => {
    if (authEnabled()) return false;
    pageHeaders(res);
    res.status(503).type("html").send(errorPage("Set APP_ADMIN_PASSWORD and restart the server before linking Alexa, so that only you can approve a link."));
    return true;
  };

  app.get("/oauth/authorize", (req, res) => {
    pageHeaders(res);
    if (refuseWithoutPassword(res)) return;
    try {
      const request = validateAuthorizationRequest(db, req.query as Record<string, unknown>);
      return res.type("html").send(consentPage(request, typeof req.query.scope === "string" ? req.query.scope.slice(0, 200) : ""));
    } catch (error) {
      if (error instanceof OAuthError) return res.status(400).type("html").send(errorPage(error.message));
      throw error;
    }
  });

  app.post("/oauth/authorize", (req, res) => {
    pageHeaders(res);
    if (refuseWithoutPassword(res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let request: AuthorizationRequest;
    try {
      request = validateAuthorizationRequest(db, body);
    } catch (error) {
      if (error instanceof OAuthError) return res.status(400).type("html").send(errorPage(error.message));
      throw error;
    }
    const expires = Number(body.consent_expires);
    if (typeof body.consent_mac !== "string" || !consentTokenOk(request, expires, body.consent_mac)) {
      return res.status(400).type("html").send(errorPage("That approval page expired. Start linking again from the Alexa app."));
    }
    if (body.decision !== "allow") return res.redirect(redirectWith(request, { error: "access_denied" }));
    return res.redirect(redirectWith(request, { code: issueCode(db, request) }));
  });

  app.post("/oauth/token", (req, res) => {
    noStore(res);
    const refuse = (error: OAuthError): Response => tokenThrottle.exceeded(req, "token-failure")
      ? res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many requests" })
      : oauthFailure(res, error);
    const client = oauthClient();
    if (!client) return refuse(new OAuthError("unauthorized_client", "Alexa linking is not configured on this server", 401));
    const presented = presentedClient(req);
    if (presented.clientId !== client.clientId || !clientSecretOk(client, presented.secret)) {
      return refuse(new OAuthError("invalid_client", "Client authentication failed", 401));
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (body.grant_type === "authorization_code") {
        return res.json(exchangeCode(db, {
          clientId: client.clientId, code: body.code, codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri, resource: body.resource,
        }));
      }
      if (body.grant_type === "refresh_token") {
        return res.json(refreshTokens(db, { clientId: client.clientId, refreshToken: body.refresh_token, resource: body.resource }));
      }
      throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
    } catch (error) {
      if (error instanceof OAuthError) return refuse(error);
      throw error;
    }
  });
}
