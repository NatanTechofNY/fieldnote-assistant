/**
 * Making and editing pages from a request: the one place the tool, the REST
 * route, and the worker all go through, so a page is filed under the same
 * scope whichever way it was asked for.
 */
import type { z } from "zod";
import { USER_ID } from "./db.ts";
import { groupIdOfAddress } from "./group-thread.ts";
import { assertSendableImage } from "./image-output.ts";
import {
  createPage, getPage, getPageBySlug, hasVoting, normalizeBlocks, PageError, pageBlocks, updatePage,
  type PageAudience, type PageBlock, type PageRow,
} from "./pages.ts";
import { OWNER_ONLY_TEMPLATES, templates, type TemplateScope } from "./page-templates/index.ts";
import type { pageBlockInput, pageCreate, pageUpdate } from "./schemas.ts";
import type { Db } from "./types.ts";

/** Where the request came from. A group turn is fenced to its group; the owner's own chat is not. */
export type PageOrigin = {
  group?: { lifeAreaId: string; threadId: string; groupId?: string };
  /** The owner's own thread, so a poll's result can come back to it. */
  threadId?: string;
};

type GroupRow = { area_id: string; area_name: string | null; thread_id: string; address: string; display_name: string | null };

function groupThread(db: Db, threadId: string): TemplateScope {
  const row = db.prepare(`
    SELECT la.id area_id,la.name area_name,t.id thread_id,t.address,t.display_name
    FROM channel_threads t JOIN life_areas la ON la.thread_id=t.id WHERE t.id=? AND t.user_id=?
  `).get(threadId, USER_ID) as GroupRow | undefined;
  const groupId = row ? groupIdOfAddress(row.address) : null;
  if (!row || !groupId) throw new PageError("That is not one of your group chats; use a thread_id from list_group_chats");
  return { lifeAreaId: row.area_id, threadId: row.thread_id, groupId, groupName: row.area_name ?? row.display_name };
}

function scopeFor(db: Db, origin: PageOrigin, threadId: string | null | undefined): TemplateScope {
  if (origin.group) {
    if (threadId && threadId !== origin.group.threadId) {
      throw new PageError("From a group you can only make pages for that group");
    }
    const scope = groupThread(db, origin.group.threadId);
    return { ...scope, groupId: origin.group.groupId ?? scope.groupId };
  }
  if (threadId) return groupThread(db, threadId);
  return { lifeAreaId: null, threadId: origin.threadId ?? null, groupId: null, groupName: null };
}

/** Every image is checked the way a picture sent in chat is: https, a picture type, and reachable. */
export async function assertPageImages(blocks: PageBlock[]): Promise<void> {
  for (const block of blocks) {
    if (block.type === "image" && block.url) await assertSendableImage(block.url);
  }
}

function shiftIso(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 86_400_000).toISOString();
}

const titleFrom = (blocks: PageBlock[]): string => {
  const head = blocks.find(block => block.type === "heading" || block.type === "poll" || block.type === "availability");
  return (head?.text || "Shared page").slice(0, 120);
};

export type CreatedPage = { page: PageRow; wroteTodos: boolean };

export async function createPageFromInput(
  db: Db,
  input: z.infer<typeof pageCreate>,
  origin: PageOrigin = {},
): Promise<CreatedPage> {
  let scope = scopeFor(db, origin, input.thread_id);
  let blocks: PageBlock[] = [];
  let title = input.title ?? "";
  let audience: PageAudience | null = input.audience ?? null;
  let kind: PageRow["kind"] | undefined;
  let template: string | null = null;
  let expiresInDays = input.expires_in_days ?? undefined;
  let wroteTodos = false;

  if (input.from_page_id) {
    const source = getPage(db, input.from_page_id);
    // From a group, only the group's own pages exist.
    if (!source || (origin.group && source.life_area_id !== origin.group.lifeAreaId)) throw new PageError("Page not found", "not_found");
    if (!input.thread_id && !origin.group && source.thread_id && source.group_id) scope = groupThread(db, source.thread_id);
    const shift = input.shift_days ?? 0;
    blocks = pageBlocks(source).map(block => ({
      ...block,
      ...(block.when && shift ? { when: shiftIso(block.when, shift) } : {}),
      ...(block.closes_at && shift ? { closes_at: shiftIso(block.closes_at, shift) } : {}),
    }));
    title ||= source.title;
    audience ??= source.audience;
    template = source.template;
    kind = source.kind === "poll" ? undefined : source.kind;
  } else if (input.template) {
    if (origin.group && OWNER_ONLY_TEMPLATES.has(input.template)) {
      throw new PageError("That page draws on the owner's private records, so it can only be made from the owner's own chat");
    }
    const built = await templates[input.template](db, scope, {
      title: input.title, items: input.items, slots: input.slots, when: input.when, todo_id: input.todo_id, closes_at: input.closes_at,
    });
    if (OWNER_ONLY_TEMPLATES.has(input.template) && input.audience === "shared") {
      throw new PageError("That page is for the owner alone and cannot be shared");
    }
    blocks = built.blocks;
    title ||= built.title;
    audience ??= built.audience;
    kind = built.kind;
    template = input.template;
    expiresInDays ??= built.expiresInDays;
    wroteTodos = Boolean(built.wroteTodos);
  }
  if (input.blocks?.length) blocks = [...blocks, ...normalizeBlocks(input.blocks)];
  if (!blocks.length) throw new PageError("The page has no content");
  title ||= titleFrom(blocks);
  // A page made in a group is the group's; one made for people to answer is shared by nature.
  if (scope.lifeAreaId && origin.group) audience = "shared";
  audience ??= (hasVoting(blocks) || blocks.some(block => block.type === "live_checklist" || block.type === "rotation")) ? "shared" : "owner";
  await assertPageImages(blocks);
  const page = createPage(db, {
    title, blocks, kind, template, audience,
    lifeAreaId: scope.lifeAreaId, threadId: scope.threadId, groupId: scope.groupId, expiresInDays,
  });
  return { page, wroteTodos };
}

export async function updatePageFromInput(db: Db, row: PageRow, input: z.infer<typeof pageUpdate>): Promise<PageRow> {
  const blocks = input.blocks ? normalizeBlocks(input.blocks as Array<z.infer<typeof pageBlockInput>>) : null;
  if (blocks) await assertPageImages(blocks);
  return updatePage(db, row, { title: input.title, blocks, expiresInDays: input.expires_in_days });
}

/** The owner's page for one local day, made once and reused: what the morning briefing links to. */
export async function ensureTodayPage(db: Db, date: string): Promise<PageRow> {
  const key = `today:${date}`;
  const existing = db.prepare("SELECT slug FROM shared_pages WHERE dedupe_key=?").get(key) as { slug: string } | undefined;
  if (existing) return getPageBySlug(db, existing.slug) as PageRow;
  const built = await templates.today(db, { lifeAreaId: null, threadId: null, groupId: null, groupName: null }, {});
  return createPage(db, {
    title: built.title, blocks: built.blocks, kind: "today", template: "today", audience: "owner",
    expiresInDays: built.expiresInDays, dedupeKey: key,
  });
}

/** A group's week in review for one local Sunday, made once and reused. */
export async function ensureGroupReviewPage(
  db: Db,
  area: { id: string; name: string; thread_id: string; groupId: string },
  date: string,
): Promise<PageRow> {
  const key = `group_week_review:${area.id}:${date}`;
  const existing = db.prepare("SELECT slug FROM shared_pages WHERE dedupe_key=?").get(key) as { slug: string } | undefined;
  if (existing) return getPageBySlug(db, existing.slug) as PageRow;
  const built = await templates.group_week_review(db, {
    lifeAreaId: area.id, threadId: area.thread_id, groupId: area.groupId, groupName: area.name,
  }, {});
  return createPage(db, {
    title: built.title, blocks: built.blocks, kind: "custom", template: "group_week_review", audience: "shared",
    lifeAreaId: area.id, threadId: area.thread_id, groupId: area.groupId, expiresInDays: built.expiresInDays, dedupeKey: key,
  });
}
