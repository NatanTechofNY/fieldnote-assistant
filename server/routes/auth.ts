import type { Request } from "express";
import { SESSION_COOKIE, authEnabled, clearFailures, clearedSessionCookie, createSession, destroySession, lockoutMsRemaining, loginPage, pruneExpiredSessions, readCookie, recordFailure, safeNextPath, sessionCookie, throttleKey, validateSession, verifyBasicAuth, verifyPassword } from "../auth.ts";
import type { RouteContext } from "./context.ts";

export function registerAuthRoutes({ app, db }: RouteContext): void {
  const overHttps = (req: Request): boolean => req.protocol === "https";

  app.get("/login", (req, res) => {
    if (!authEnabled()) return res.redirect("/");
    const next = safeNextPath(req.query.next);
    if (validateSession(db, readCookie(req, SESSION_COOKIE))) return res.redirect(next);
    return res.type("html").send(loginPage({ next }));
  });

  app.post("/login", (req, res) => {
    if (!authEnabled()) return res.redirect("/");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = safeNextPath(body.next);
    const throttle = throttleKey(req);

    const lockout = lockoutMsRemaining(throttle);
    if (lockout > 0) {
      return res.status(429).type("html").send(loginPage({
        next,
        error: `Too many attempts. Try again in ${Math.ceil(lockout / 60000)} minute(s).`,
      }));
    }

    if (typeof body.password !== "string" || !verifyPassword(body.password)) {
      recordFailure(throttle);
      return res.status(401).type("html").send(loginPage({ next, error: "Incorrect password." }));
    }

    clearFailures(throttle);
    pruneExpiredSessions(db);
    const token = createSession(db, req.get("user-agent"));
    res.setHeader("Set-Cookie", sessionCookie(token, overHttps(req)));
    return res.redirect(next);
  });

  app.post("/logout", (req, res) => {
    destroySession(db, readCookie(req, SESSION_COOKIE));
    res.setHeader("Set-Cookie", clearedSessionCookie(overHttps(req)));
    return res.redirect("/login");
  });

  app.use((req, res, next) => {
    if (!authEnabled()) {
      res.locals.authenticated = true;
      return next();
    }

    // Scripts and integrations keep using Basic Auth; browsers use the session.
    const authorization = req.headers.authorization;
    if (authorization) {
      if (verifyBasicAuth(authorization)) {
        res.locals.authenticated = true;
        return next();
      }
      recordFailure(throttleKey(req));
      res.setHeader("WWW-Authenticate", 'Basic realm="Fieldnote"');
      return res.status(401).send("Authentication required");
    }

    if (validateSession(db, readCookie(req, SESSION_COOKIE))) {
      res.locals.authenticated = true;
      return next();
    }

    res.locals.authenticated = false;
    // Platform health checks and provider webhooks cannot present credentials.
    if (req.path.startsWith("/api/webhooks/") || req.path === "/api/health") return next();
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    if (req.method === "GET") {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).send("Authentication required");
  });
}
