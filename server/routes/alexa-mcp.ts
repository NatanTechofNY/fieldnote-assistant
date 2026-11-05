import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { HOUSEHOLD_OAUTH_SCOPE, revokeAllTokens, linkedSince, oauthClient, verifyAccessToken, canonicalResource } from "../alexa-oauth.ts";
import { alexaStatus } from "../alexa-control.ts";
import { buildHouseholdServer } from "../alexa-mcp-server.ts";
import { failure, success } from "../http.ts";
import { slidingWindow } from "../rate-limit.ts";
import { HOUSEHOLD_AREA_NAME } from "../household.ts";
import type { RouteContext } from "./context.ts";

/*
 * `/mcp` is public to the sign-in gate (`isAlexaPublicPath`), so this file is
 * its gate: no valid Household bearer token, no tools. Failures are counted
 * per caller, so guessing tokens runs into a wall long before it gets
 * anywhere, and a plain 401 is returned with no `WWW-Authenticate` header,
 * which Alexa+ does not support.
 */

const REQUESTS_PER_WINDOW = 600;
const FAILURES_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60_000;
const requests = slidingWindow(REQUESTS_PER_WINDOW, WINDOW_MS);
const failures = slidingWindow(FAILURES_PER_WINDOW, WINDOW_MS);

/** For tests: forget every caller's recent requests and failures. */
export function resetMcpThrottle(): void {
  requests.clear();
  failures.clear();
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  // A token in the query string is refused rather than read: it would end up in logs.
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

export function registerAlexaMcpRoutes({ app, db, search }: RouteContext): void {
  const unauthorized = (res: Response) => res.status(401).json({ error: "unauthorized", error_description: "A valid access token is required" });

  app.post("/mcp", async (req, res) => {
    const granted = verifyAccessToken(db, bearerToken(req));
    if (!granted || !granted.scope.split(" ").includes(HOUSEHOLD_OAUTH_SCOPE)) {
      // Every refusal counts, but only a caller already over the limit is told so.
      if (failures.exceeded(req, "mcp-failure")) return res.status(429).json({ error: "temporarily_unavailable" });
      return unauthorized(res);
    }
    // Only a request with a live token counts toward the cap. Behind a proxy every caller shares one peer, so counting
    // the refused ones too would let anyone on the internet spend the cap and shut a linked Echo out.
    if (requests.exceeded(req, "mcp")) return res.status(429).json({ error: "temporarily_unavailable" });
    // Stateless: a request is answered on its own, so nothing is kept between calls and nothing needs an expiry.
    const server = buildHouseholdServer(db, search);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  // Stateless servers have no stream to open and no session to end.
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).setHeader("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", (req, res) => (verifyAccessToken(db, bearerToken(req)) ? notAllowed(req, res) : unauthorized(res)));
  app.delete("/mcp", (req, res) => (verifyAccessToken(db, bearerToken(req)) ? notAllowed(req, res) : unauthorized(res)));

  /* The owner's side, behind the sign-in gate like the rest of /api. */
  app.get("/api/integrations/alexa", async (_req, res, next) => {
    try {
      success(res, {
        linking: {
          configured: Boolean(oauthClient()),
          resource: canonicalResource(db),
          linkedSince: linkedSince(db),
          area: HOUSEHOLD_AREA_NAME,
        },
        // Whether Fieldnote can reach the owner's devices; never more than a yes, a count and a reason.
        control: await alexaStatus(),
      });
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/integrations/alexa/link", (_req, res) => {
    if (!oauthClient()) return failure(res, 404, "Alexa linking is not configured");
    return success(res, { unlinked: true, revoked: revokeAllTokens(db) });
  });
}
