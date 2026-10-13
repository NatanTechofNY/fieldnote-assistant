/**
 * What hosted pages do on the worker's tick: tell the chat a poll has closed,
 * nudge the people who have not voted, echo a burst of votes or ticks back to
 * the chat the page was sent to, and post a group's week in review on Sunday.
 * Sweeping old pages is `runMaintenance`'s.
 *
 * None of it needs a dispatch row: every step leaves its own mark on the page
 * (`results_posted_at`, `nudged_at`, an event's `echoed_at`), set before the
 * text goes out and cleared again if it fails, so a tick that runs twice sends
 * once. The worker is the only writer, so nothing races that.
 */
import { USER_ID } from "./db.ts";
import { groupIdOfAddress } from "./group-thread.ts";
import { isSmsProviderConnected, type SmsSender } from "./messaging.ts";
import { recordOutboundChannelMessage } from "./agent-runner.ts";
import { ensureGroupReviewPage } from "./page-service.ts";
import {
  closeoutText, echoText, markEchoed, nudgeText, pagesAwaitingResults, pagesToNudge, pendingEchoes,
  tryPublicPageUrl, type PageRow,
} from "./pages.ts";
import type { Db } from "./types.ts";

type Destination = { address: string; groupId?: string };

/** Where a page's chat is, or null when it has none the app can text (a browser thread, a group the provider cannot reach). */
function destinationOf(db: Db, page: PageRow): Destination | null {
  if (!page.thread_id) return null;
  const thread = db.prepare("SELECT channel,address FROM channel_threads WHERE id=? AND user_id=?")
    .get(page.thread_id, USER_ID) as { channel: string; address: string } | undefined;
  if (!thread || thread.channel !== "sms") return null;
  const groupId = groupIdOfAddress(thread.address);
  if (groupId && !isSmsProviderConnected(db, "sendblue")) return null;
  return groupId ? { address: thread.address, groupId } : { address: thread.address };
}

async function say(
  db: Db,
  send: SmsSender,
  destination: Destination,
  text: string,
  kind: string,
  page: PageRow,
): Promise<void> {
  const sent = await send(db, destination.address, text, destination.groupId ? { groupId: destination.groupId } : undefined);
  recordOutboundChannelMessage(db, "sms", destination.address, text, sent.sid, sent.status, { kind, pageId: page.id });
}

/** Sets a page column before the send and puts it back if the send fails. */
async function claimed(
  db: Db,
  page: PageRow,
  column: "results_posted_at" | "nudged_at",
  work: () => Promise<void>,
): Promise<void> {
  db.prepare(`UPDATE shared_pages SET ${column}=? WHERE id=?`).run(new Date().toISOString(), page.id);
  try {
    await work();
  } catch (error) {
    db.prepare(`UPDATE shared_pages SET ${column}=NULL WHERE id=?`).run(page.id);
    throw error;
  }
}

export type PageJobOptions = {
  send: SmsSender;
  /** Texts wait while quiet hours hold. */
  quiet: boolean;
  /** The owner's local date and time, for the Sunday review. */
  local: { date: string; time: string };
};

/** Local time after which a group's Sunday week in review goes out. */
export const WEEK_REVIEW_TIME = "18:00";

export async function runPageJobs(db: Db, options: PageJobOptions): Promise<void> {
  const { send, quiet, local } = options;
  if (!quiet) {
    for (const page of pagesAwaitingResults(db)) {
      const destination = destinationOf(db, page);
      try {
        await claimed(db, page, "results_posted_at", async () => {
          // A chat the app cannot text still counts as told: the result is on the page.
          if (destination) await say(db, send, destination, closeoutText(db, page), "poll_results", page);
        });
      } catch (error) {
        console.warn(`Could not post the results of "${page.title}":`, error instanceof Error ? error.message : error);
      }
    }
    for (const { page, missing } of pagesToNudge(db)) {
      const destination = destinationOf(db, page);
      try {
        await claimed(db, page, "nudged_at", async () => {
          if (destination) await say(db, send, destination, nudgeText(db, page, missing), "poll_nudge", page);
        });
      } catch (error) {
        console.warn(`Could not nudge about "${page.title}":`, error instanceof Error ? error.message : error);
      }
    }
    for (const pending of pendingEchoes(db)) {
      const destination = destinationOf(db, pending.page);
      const ids = pending.events.map(event => event.id);
      try {
        // Settled first, so a failed send is dropped rather than repeated every minute.
        markEchoed(db, ids);
        if (destination) await say(db, send, destination, echoText(db, pending), "page_update", pending.page);
      } catch (error) {
        console.warn(`Could not echo activity on "${pending.page.title}":`, error instanceof Error ? error.message : error);
      }
    }
    if (isSmsProviderConnected(db, "sendblue")) await postWeekReviews(db, send, local);
  }
}

/** A group's week in review, on Sunday evening, for the groups that turned it on. */
async function postWeekReviews(db: Db, send: SmsSender, local: { date: string; time: string }): Promise<void> {
  if (new Date(`${local.date}T12:00:00Z`).getUTCDay() !== 0 || local.time < WEEK_REVIEW_TIME) return;
  const areas = db.prepare(`
    SELECT la.id,la.name,la.thread_id,t.address FROM life_areas la JOIN channel_threads t ON t.id=la.thread_id
    WHERE la.user_id=? AND la.weekly_review_page=1 AND la.thread_id IS NOT NULL
  `).all(USER_ID) as Array<{ id: string; name: string; thread_id: string; address: string }>;
  for (const area of areas) {
    const groupId = groupIdOfAddress(area.address);
    if (!groupId) continue;
    try {
      const page = await ensureGroupReviewPage(db, { id: area.id, name: area.name, thread_id: area.thread_id, groupId }, local.date);
      const url = tryPublicPageUrl(db, page.slug);
      if (!url || page.results_posted_at) continue;
      await claimed(db, page, "results_posted_at", () =>
        say(db, send, { address: area.address, groupId }, `${area.name}: the week in review. ${url}`, "group_week_review", page));
    } catch (error) {
      console.warn(`Could not post the week in review for "${area.name}":`, error instanceof Error ? error.message : error);
    }
  }
}
