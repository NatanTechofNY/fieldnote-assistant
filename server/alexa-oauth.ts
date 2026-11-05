import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { id, now } from "./db.ts";
import { publicBaseUrl } from "./pages.ts";
import type { Db } from "./types.ts";

/*
 * Fieldnote as the authorization server for Alexa+ account linking. Amazon's
 * MCP toolkit needs OAuth 2.1 authorization code with PKCE (S256) and a
 * `resource` on both the authorization and token requests; it does not do
 * dynamic client registration, so the one client is configured in the
 * environment and given to Amazon with `alexa-ai configure-account-linking`.
 *
 * Codes and tokens are opaque and only their SHA-256 hashes are stored, so a
 * leaked database cannot be replayed against `/mcp`.
 */

/** What a linked Echo may do: the Household area's tools and nothing else. */
export const HOUSEHOLD_OAUTH_SCOPE = "household";

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
/** How long a consent page stays valid once drawn. */
export const CONSENT_TTL_MS = 10 * 60_000;

/**
 * Where Alexa sends the customer back to. Amazon has several of these (the
 * one used depends on where the customer's device is registered) and says to
 * use whichever it passes at runtime, so the default accepts its own hosts
 * rather than one fixed URI. `ALEXA_OAUTH_REDIRECT_URIS` replaces that with an
 * exact list, which is what `alexa-ai configure-account-linking` prints.
 */
const AMAZON_REDIRECT = /^https:\/\/(?:alexa|pitangui|layla)\.amazon\.com\/api\/skill\/link\/[A-Za-z0-9_-]+$/;

export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

export type OAuthClient = { clientId: string; clientSecret: string; redirectUris: string[] };

/** The one configured client, or null while linking is not set up. */
export function oauthClient(): OAuthClient | null {
  const clientId = process.env.ALEXA_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: process.env.ALEXA_OAUTH_CLIENT_SECRET?.trim() ?? "",
    redirectUris: (process.env.ALEXA_OAUTH_REDIRECT_URIS ?? "").split(",").map(uri => uri.trim()).filter(Boolean),
  };
}

export function redirectUriAllowed(client: OAuthClient, uri: unknown): uri is string {
  if (typeof uri !== "string" || !uri) return false;
  return client.redirectUris.length ? client.redirectUris.includes(uri) : AMAZON_REDIRECT.test(uri);
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Whether the secret presented for the client is right; a client with no secret configured needs none. */
export function clientSecretOk(client: OAuthClient, presented: string | undefined): boolean {
  if (!client.clientSecret) return true;
  return presented !== undefined && safeEqual(client.clientSecret, presented);
}

/* Addresses ---------------------------------------------------------------- */

/** The MCP server's canonical URI, the `resource` every request must name; null without a public address. */
export function canonicalResource(db: Db): string | null {
  const base = publicBaseUrl(db);
  return base ? `${base}/mcp` : null;
}

export function issuerOf(db: Db): string | null {
  return publicBaseUrl(db);
}

/** Whether `value` names this server's MCP endpoint, trailing slash aside. */
export function resourceMatches(db: Db, value: unknown): boolean {
  const canonical = canonicalResource(db);
  return Boolean(canonical && typeof value === "string" && value.replace(/\/+$/, "") === canonical);
}

/** The discovery document for the MCP server (RFC 9728). */
export function protectedResourceMetadata(db: Db): Record<string, unknown> | null {
  const resource = canonicalResource(db);
  const issuer = issuerOf(db);
  if (!resource || !issuer) return null;
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [HOUSEHOLD_OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

/** The discovery document for the authorization server (RFC 8414). */
export function authorizationServerMetadata(db: Db): Record<string, unknown> | null {
  const issuer = issuerOf(db);
  if (!issuer) return null;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: [HOUSEHOLD_OAUTH_SCOPE],
  };
}

/** Every path that must be reachable without a session; the gate in `routes/auth.ts` checks it before anything else. */
export function isAlexaPublicPath(path: string): boolean {
  return path === "/mcp" || path === "/mcp/"
    || path === "/oauth/token"
    || path === "/.well-known/oauth-authorization-server"
    || path === "/.well-known/oauth-protected-resource"
    || path === "/.well-known/oauth-protected-resource/mcp";
}

/* The consent page's own proof that it was drawn for this request ----------- */

const consentKey = randomBytes(32);

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string;
};

function consentMac(request: AuthorizationRequest, expires: number): string {
  return createHmac("sha256", consentKey)
    .update([request.clientId, request.redirectUri, request.codeChallenge, request.resource, request.state, expires].join("\n"))
    .digest("hex");
}

/** A token the consent form carries, so a post is accepted only for a page this process drew. */
export function consentToken(request: AuthorizationRequest): { expires: number; mac: string } {
  const expires = Date.now() + CONSENT_TTL_MS;
  return { expires, mac: consentMac(request, expires) };
}

export function consentTokenOk(request: AuthorizationRequest, expires: number, mac: string): boolean {
  return Number.isFinite(expires) && expires > Date.now() && safeEqual(consentMac(request, expires), mac);
}

/** Checks the parts of an authorization request every step has to agree on. */
export function validateAuthorizationRequest(db: Db, query: Record<string, unknown>): AuthorizationRequest {
  const client = oauthClient();
  if (!client) throw new OAuthError("unauthorized_client", "Alexa linking is not configured on this server");
  if (query.client_id !== client.clientId) throw new OAuthError("unauthorized_client", "Unknown client");
  if (!redirectUriAllowed(client, query.redirect_uri)) throw new OAuthError("invalid_request", "That redirect address is not allowed");
  if (query.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only the authorization code flow is supported");
  const challenge = typeof query.code_challenge === "string" ? query.code_challenge : "";
  if (query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new OAuthError("invalid_request", "PKCE with the S256 method is required");
  }
  if (!resourceMatches(db, query.resource)) {
    throw new OAuthError("invalid_target", "The resource must be this server's MCP address");
  }
  return {
    clientId: client.clientId,
    redirectUri: query.redirect_uri,
    codeChallenge: challenge,
    resource: canonicalResource(db) as string,
    state: typeof query.state === "string" ? query.state.slice(0, 1000) : "",
  };
}

/* Codes and tokens ---------------------------------------------------------- */

/** A one-use code for an approved request. */
export function issueCode(db: Db, request: AuthorizationRequest): string {
  const code = randomBytes(32).toString("base64url");
  const timestamp = now();
  db.prepare("DELETE FROM oauth_codes WHERE expires_at<=?").run(timestamp);
  db.prepare(`
    INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,resource,scope,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(
    sha256(code), request.clientId, request.redirectUri, request.codeChallenge, request.resource,
    HOUSEHOLD_OAUTH_SCOPE, new Date(Date.now() + CODE_TTL_MS).toISOString(), timestamp,
  );
  return code;
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/** `linkedAt` is when the customer first approved; a refresh carries it forward so "linked since" stays true. */
function mintTokens(db: Db, clientId: string, resource: string, scope: string, linkedAt = now()): TokenResponse {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const timestamp = now();
  db.prepare("DELETE FROM oauth_tokens WHERE refresh_expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<?)")
    .run(timestamp, new Date(Date.now() - 7 * 86_400_000).toISOString());
  db.prepare(`
    INSERT INTO oauth_tokens(id,access_hash,refresh_hash,client_id,scope,resource,access_expires_at,refresh_expires_at,linked_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    id("oauth"), sha256(access), sha256(refresh), clientId, scope, resource,
    new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(), new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
    linkedAt, timestamp,
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

type CodeRow = {
  client_id: string; redirect_uri: string; code_challenge: string; resource: string; scope: string;
  expires_at: string; used_at: string | null;
};

/** Trades a code and its PKCE verifier for tokens. Every check failing is the same `invalid_grant` to the caller. */
export function exchangeCode(
  db: Db,
  input: { clientId: string; code: unknown; codeVerifier: unknown; redirectUri: unknown; resource: unknown },
): TokenResponse {
  const grant = (message: string) => new OAuthError("invalid_grant", message);
  if (typeof input.code !== "string" || !input.code) throw new OAuthError("invalid_request", "A code is required");
  if (typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
    throw new OAuthError("invalid_request", "A PKCE code_verifier is required");
  }
  if (!resourceMatches(db, input.resource)) throw new OAuthError("invalid_target", "The resource must be this server's MCP address");
  const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash=?").get(sha256(input.code)) as CodeRow | undefined;
  if (!row) throw grant("That code is not valid");
  // A code is spent by the first attempt, whether or not the rest of the request is right.
  const spent = db.prepare("UPDATE oauth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").run(now(), sha256(input.code));
  if (!spent.changes || row.used_at) throw grant("That code was already used");
  if (row.expires_at <= now()) throw grant("That code has expired");
  if (row.client_id !== input.clientId) throw grant("That code was issued to another client");
  if (row.redirect_uri !== input.redirectUri) throw grant("The redirect address does not match the authorization request");
  if (row.resource !== (input.resource as string).replace(/\/+$/, "")) throw grant("The resource does not match the authorization request");
  const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
  if (!safeEqual(challenge, row.code_challenge)) throw grant("The PKCE verifier does not match");
  return mintTokens(db, row.client_id, row.resource, row.scope);
}

type TokenRow = {
  id: string; client_id: string; scope: string; resource: string; linked_at: string;
  access_expires_at: string; refresh_expires_at: string; revoked_at: string | null;
};

/** Rotates a refresh token: the old pair stops working the moment the new one is issued. */
export function refreshTokens(db: Db, input: { clientId: string; refreshToken: unknown; resource: unknown }): TokenResponse {
  if (typeof input.refreshToken !== "string" || !input.refreshToken) throw new OAuthError("invalid_request", "A refresh_token is required");
  if (input.resource !== undefined && input.resource !== "" && !resourceMatches(db, input.resource)) {
    throw new OAuthError("invalid_target", "The resource must be this server's MCP address");
  }
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE refresh_hash=?").get(sha256(input.refreshToken)) as TokenRow | undefined;
  if (!row || row.revoked_at || row.refresh_expires_at <= now() || row.client_id !== input.clientId) {
    throw new OAuthError("invalid_grant", "That refresh token is not valid");
  }
  return db.transaction(() => {
    db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE id=?").run(now(), row.id);
    return mintTokens(db, row.client_id, row.resource, row.scope, row.linked_at);
  })();
}

/** The scope a bearer token grants, or null for anything that is not a live access token for this server. */
export function verifyAccessToken(db: Db, token: string | undefined): { scope: string } | null {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE access_hash=?").get(sha256(token)) as TokenRow | undefined;
  if (!row || row.revoked_at || row.access_expires_at <= now()) return null;
  db.prepare("UPDATE oauth_tokens SET last_used_at=? WHERE id=?").run(now(), row.id);
  return { scope: row.scope };
}

/** Unlinks Alexa: every token stops working, and any code still waiting is dropped. */
export function revokeAllTokens(db: Db): number {
  db.prepare("DELETE FROM oauth_codes").run();
  return db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE revoked_at IS NULL").run(now()).changes;
}

/** When the current link was made, or null while nothing is linked. */
export function linkedSince(db: Db): string | null {
  const row = db.prepare(`
    SELECT min(linked_at) since FROM oauth_tokens WHERE revoked_at IS NULL AND refresh_expires_at>?
  `).get(now()) as { since: string | null };
  return row.since;
}
