/**
 * Making and editing pages from a request: the one place the tool, the REST
 * route, and the worker all go through, so a page is filed under the same
 * scope whichever way it was asked for.
 */
import type { z } from "zod";
import { attachmentsForMemories } from "./attachments.ts";
import { USER_ID } from "./db.ts";
import { groupIdOfAddress } from "./group-thread.ts";
import { assertSendableImage } from "./image-output.ts";
import {
  createPage, getPage, getPageBySlug, hasVoting, normalizeBlocks, PageError, pageAttachmentIds, pageBlocks, pageIsLive, pictureProblem, updatePage,
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

const MAX_PAGE_PICTURES = 40;

/** Saved pictures on a page must be the page's own chat's, and never the owner's on a page anyone can open. */
export function assertPagePictures(db: Db, blocks: PageBlock[], audience: PageAudience, lifeAreaId: string | null): void {
  const ids = pageAttachmentIds(blocks);
  // Each one is looked up whenever the page is drawn, so a page holds a bounded number.
  if (ids.length > MAX_PAGE_PICTURES) throw new PageError(`A page can show at most ${MAX_PAGE_PICTURES} pictures; this one names ${ids.length}`);
  for (const attachmentId of ids) {
    const problem = pictureProblem(db, attachmentId, audience, lifeAreaId);
    if (problem) throw new PageError(problem);
  }
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
  // Template and copied blocks carry no usable ids (a copy starts without votes), so all of them are numbered together with the caller's.
  if (blocks.length || input.blocks?.length) {
    blocks = normalizeBlocks([
      ...blocks.map(({ id: _id, ...block }) => block),
      ...(input.blocks ?? []),
    ] as Array<z.infer<typeof pageBlockInput>>);
  }
  if (!blocks.length) throw new PageError("The page has no content");
  title ||= titleFrom(blocks);
  // A page made in a group is the group's; one made for people to answer is shared by nature.
  if (scope.lifeAreaId && origin.group) audience = "shared";
  audience ??= (hasVoting(blocks) || blocks.some(block => block.type === "live_checklist" || block.type === "rotation")) ? "shared" : "owner";
  // A poll is answered by other people, and a chat is told its link: it cannot sit behind the owner's sign-in.
  if (hasVoting(blocks)) audience = "shared";
  // Whatever way it was made (a template, or a copy of one), what is read from the owner's records stays the owner's.
  if (template && OWNER_ONLY_TEMPLATES.has(template as never) && (audience === "shared" || scope.lifeAreaId)) {
    throw new PageError("That page draws on the owner's private records, so it can only be the owner's own and cannot be shared or filed under a group");
  }
  await assertPageImages(blocks);
  assertPagePictures(db, blocks, audience, scope.lifeAreaId);
  const page = createPage(db, {
    title, blocks, kind, template, audience,
    lifeAreaId: scope.lifeAreaId, threadId: scope.threadId, groupId: scope.groupId, expiresInDays,
  });
  return { page, wroteTodos };
}

export async function updatePageFromInput(db: Db, row: PageRow, input: z.infer<typeof pageUpdate>): Promise<PageRow> {
  // A block sent back without its id keeps the one it had, matched by kind and words, so votes stay with the question
  // they were cast on when blocks are added or reordered around it.
  const existing = pageBlocks(row).filter(block => block.id);
  const claimed = new Set((input.blocks ?? []).map(block => block.id).filter(Boolean));
  const taken = new Set([...existing.map(old => old.id), ...claimed]);
  const incoming = (input.blocks ?? []).map(block => {
    if (block.id) return block;
    const same = existing.find(old => !claimed.has(old.id) && old.type === block.type && old.text === block.text);
    if (same) {
      claimed.add(same.id);
      return { ...block, id: same.id };
    }
    // A new block never takes an id a block of the page has had, so a removed block's votes cannot pass to it.
    let number = 1;
    while (taken.has(`${block.type}${number}`)) number += 1;
    taken.add(`${block.type}${number}`);
    return { ...block, id: `${block.type}${number}` };
  });
  const blocks = input.blocks ? normalizeBlocks(incoming as Array<z.infer<typeof pageBlockInput>>) : null;
  if (blocks) {
    await assertPageImages(blocks);
    assertPagePictures(db, blocks, row.audience, row.life_area_id);
  }
  return updatePage(db, row, { title: input.title, blocks, expiresInDays: input.expires_in_days });
}

/** The owner's page for one local day, made once and reused: what the morning briefing links to. */
export async function ensureTodayPage(db: Db, date: string): Promise<PageRow> {
  const key = `today:${date}`;
  const existing = db.prepare("SELECT slug FROM shared_pages WHERE dedupe_key=?").get(key) as { slug: string } | undefined;
  const found = existing && getPageBySlug(db, existing.slug);
  // An expired page is not one to link to; a revoked one has let go of its key.
  if (found && pageIsLive(found)) return found;
  if (found) db.prepare("UPDATE shared_pages SET dedupe_key=NULL WHERE id=?").run(found.id);
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
  const found = existing && getPageBySlug(db, existing.slug);
  // An expired page is not one to link to; a revoked one has let go of its key.
  if (found && pageIsLive(found)) return found;
  if (found) db.prepare("UPDATE shared_pages SET dedupe_key=NULL WHERE id=?").run(found.id);
  const built = await templates.group_week_review(db, {
    lifeAreaId: area.id, threadId: area.thread_id, groupId: area.groupId, groupName: area.name,
  }, {});
  return createPage(db, {
    title: built.title, blocks: built.blocks, kind: "custom", template: "group_week_review", audience: "shared",
    lifeAreaId: area.id, threadId: area.thread_id, groupId: area.groupId, expiresInDays: built.expiresInDays, dedupeKey: key,
  });
}

/* Pictures the group already saved that belong on a page ---------------------- */

const TOPIC_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "will", "your", "plan", "page", "list", "what", "when", "where", "about", "into",
  "before", "after", "going", "there", "their", "them", "then", "than", "some", "just", "check", "the", "and",
]);

const topicWords = (text: string): string[] =>
  [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter(word => !TOPIC_STOPWORDS.has(word));

export type RelatedPicture = {
  attachment_id: string;
  description: string | null;
  kind: string;
  memory_id: string;
  memory_title: string | null;
};

/**
 * The pictures a group has kept with its memories that bear on a page it has
 * just made, so the agent can put a ticket or a confirmation on the page that
 * plans the evening the ticket is for. Nothing is added here: the model is
 * handed the candidates and decides.
 *
 * Only a group's own page looks, and only among that group's own memories: a
 * memory is read by its area, and each picture has to be one a page of this
 * audience and area may show (`pictureProblem`), so the owner's own pictures and
 * another group's never turn up. A memory matches on the page's words beyond
 * the group's own name, which every memory of the group shares, in its title,
 * text, and what its pictures say. Pictures already on the page are left out.
 */
export function relatedPagePictures(db: Db, page: PageRow, limit = 5): RelatedPicture[] {
  if (!page.life_area_id || !page.group_id) return [];
  const area = db.prepare("SELECT name FROM life_areas WHERE id=? AND user_id=?").get(page.life_area_id, USER_ID) as { name: string | null } | undefined;
  const groupWords = new Set(topicWords(area?.name ?? ""));
  const blocks = pageBlocks(page);
  const words = topicWords([page.title, ...blocks.flatMap(block => [block.text, ...(block.items ?? [])])].filter(Boolean).join(" "))
    .filter(word => !groupWords.has(word));
  if (!words.length) return [];
  const memories = db.prepare(`
    SELECT id,title,content FROM memories
    WHERE user_id=? AND life_area_id=? AND id IN (SELECT memory_id FROM memory_attachments)
    ORDER BY created_at DESC LIMIT 200
  `).all(USER_ID, page.life_area_id) as Array<{ id: string; title: string | null; content: string }>;
  const pictures = attachmentsForMemories(db, memories.map(memory => memory.id));
  const onPage = new Set(pageAttachmentIds(blocks));
  const found: Array<RelatedPicture & { score: number }> = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    const kept = (pictures.get(memory.id) ?? []).filter(picture => !onPage.has(picture.id) && !seen.has(picture.id)
      && pictureProblem(db, picture.id, page.audience, page.life_area_id) === null);
    if (!kept.length) continue;
    const text = [memory.title, memory.content, ...kept.map(picture => picture.description)].join(" ").toLowerCase();
    const score = words.filter(word => text.includes(word)).length;
    if (!score) continue;
    for (const picture of kept) {
      seen.add(picture.id);
      found.push({
        attachment_id: picture.id, description: picture.description ? picture.description.slice(0, 200) : null,
        kind: picture.kind, memory_id: memory.id, memory_title: memory.title, score,
      });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _score, ...picture }) => picture);
}
