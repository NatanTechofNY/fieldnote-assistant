import type { Request, Response } from "express";
import { authEnabled, throttleKey } from "../auth.ts";
import { claimChecklistItem, toggleChecklistItem } from "../page-live.ts";
import { pageCalendar } from "../page-ics.ts";
import { pageOgImage } from "../page-og.ts";
import { noticeFor, renderPage, renderUnavailable } from "../page-render.ts";
import {
  cleanVoterName, getPageBySlug, isPreviewFetcher, PageError, pageIsLive, recordPageView, recordVote, type PageRow,
} from "../pages.ts";
import type { RouteContext } from "./context.ts";

/*
 * The public surface of the app: `/p/*` is exempt from the sign-in gate in
 * `routes/auth.ts`, because the people a page is sent to have no account.
 * What an unauthenticated caller can do here is bounded by this file:
 *   - read a page whose unguessable link they hold, if it is a shared one
 *     that has not expired or been revoked (an owner page redirects to sign-in);
 *   - answer a poll or availability grid under a name they type;
 *   - tick or claim a step of a shared checklist on that page.
 * Nothing here reaches any record the page's own blocks do not name.
 */

const SLUG = /^[A-Za-z0-9_-]{22}$/;
const VOTER_COOKIE = "fn_voter";
const WRITES_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;
const writes = new Map<string, number[]>();

/** Writes per caller, counted separately from sign-in failures so a family on one wifi can all vote. */
function tooManyWrites(req: Request): boolean {
  const key = throttleKey(req);
  const cutoff = Date.now() - WINDOW_MS;
  const recent = (writes.get(key) ?? []).filter(at => at > cutoff);
  if (writes.size > 2000) {
    for (const [candidate, times] of writes) if (!times.some(at => at > cutoff)) writes.delete(candidate);
  }
  if (recent.length >= WRITES_PER_WINDOW) {
    writes.set(key, recent);
    return true;
  }
  writes.set(key, [...recent, Date.now()]);
  return false;
}

/** For tests: forget every caller's recent writes. */
export function resetPageWriteThrottle(): void {
  writes.clear();
}

/** A signed-in owner. With no password set everyone is "authenticated", so nobody counts as the owner. */
const signedInOwner = (res: Response): boolean => authEnabled() && res.locals.authenticated === true;

const formCode = (error: PageError): string => (["name", "closed", "option"].includes(error.code) ? error.code : "gone");

function secure(res: Response): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

const voterCookie = (name: string, secureCookie: boolean): string => [
  `${VOTER_COOKIE}=${encodeURIComponent(name)}`, "Path=/p/", "HttpOnly", "SameSite=Lax", `Max-Age=${180 * 86_400}`,
  ...(secureCookie ? ["Secure"] : []),
].join("; ");

function readVoter(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === VOTER_COOKIE) {
      try {
        return cleanVoterName(decodeURIComponent(part.slice(separator + 1).trim())) || undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function registerPublicPageRoutes({ app, db, search }: RouteContext): void {
  const unavailable = (res: Response) => {
    secure(res);
    return res.status(404).type("html").send(renderUnavailable());
  };

  /** The page for this request, or the response that says why not. Owner pages need a session. */
  const open = (req: Request, res: Response): PageRow | undefined => {
    const slug = String(req.params.slug ?? "");
    const page = SLUG.test(slug) ? getPageBySlug(db, slug) : undefined;
    if (!page || !pageIsLive(page)) {
      unavailable(res);
      return undefined;
    }
    if (page.audience === "owner" && res.locals.authenticated !== true) {
      secure(res);
      res.redirect(303, `/login?next=${encodeURIComponent(`/p/${page.slug}`)}`);
      return undefined;
    }
    return page;
  };

  const back = (res: Response, page: PageRow, code: string, anchor = "") =>
    res.redirect(303, `/p/${page.slug}?n=${code}${anchor ? `#${anchor}` : ""}`);

  // The picture a link preview shows. Registered ahead of `/p/:slug`, which would otherwise take it.
  app.get("/p/og.png", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(pageOgImage());
  });

  app.get("/p/:slug", async (req, res, next) => {
    try {
      const page = open(req, res);
      if (!page) return;
      if (!isPreviewFetcher(req.get("user-agent"))) recordPageView(db, page);
      secure(res);
      res.type("html").send(await renderPage(db, page, {
        viewerIsOwner: signedInOwner(res),
        voterName: readVoter(req),
        notice: noticeFor(req.query.n),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/p/:slug/event.ics", (req, res) => {
    const page = open(req, res);
    if (!page) return;
    const calendar = pageCalendar(db, page);
    if (!calendar) return unavailable(res);
    secure(res);
    res.setHeader("Content-Disposition", 'attachment; filename="event.ics"');
    return res.type("text/calendar").send(calendar);
  });

  app.post("/p/:slug/name", (req, res) => {
    const page = open(req, res);
    if (!page) return;
    const name = cleanVoterName((req.body as Record<string, unknown> | undefined)?.name);
    if (!name) return back(res, page, "name");
    res.setHeader("Set-Cookie", voterCookie(name, req.protocol === "https"));
    return back(res, page, "checked");
  });

  app.post("/p/:slug/vote", (req, res) => {
    const page = open(req, res);
    if (!page) return;
    if (tooManyWrites(req)) return back(res, page, "slow");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const options = ([] as unknown[]).concat(body.option ?? []).map(String);
    try {
      const vote = recordVote(db, page, {
        blockId: String(body.block ?? ""),
        name: body.name,
        optionIds: options,
        byOwner: signedInOwner(res),
      });
      res.setHeader("Set-Cookie", voterCookie(vote.name, req.protocol === "https"));
      return back(res, page, "voted", String(body.block ?? ""));
    } catch (error) {
      if (error instanceof PageError) return back(res, page, formCode(error), String(body.block ?? ""));
      throw error;
    }
  });

  app.post("/p/:slug/check", (req, res) => {
    const page = open(req, res);
    if (!page) return;
    if (tooManyWrites(req)) return back(res, page, "slow");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actor = cleanVoterName(body.name) || readVoter(req);
    if (!actor) return back(res, page, "name");
    const input = { blockId: String(body.block ?? ""), todoId: String(body.todo ?? ""), actor };
    try {
      if (body.action === "claim") claimChecklistItem(db, page, input);
      else toggleChecklistItem(db, page, input);
      search.flushSoon();
      res.setHeader("Set-Cookie", voterCookie(actor, req.protocol === "https"));
      return back(res, page, "checked", input.blockId);
    } catch (error) {
      if (error instanceof PageError) return back(res, page, formCode(error), input.blockId);
      throw error;
    }
  });
}
