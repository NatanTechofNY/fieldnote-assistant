/*
 * Pictures people text the assistant, kept as files so a receipt or an invoice
 * is still there after the provider's link expires. SQLite holds the rows and
 * the description; the bytes live in a directory beside the database (or
 * `ATTACHMENTS_DIR`), one file per picture, named by its attachment id.
 *
 * A picture is staged before the message that carried it is archived, because
 * downloading is asynchronous and archiving is not. The staged row names the
 * provider's message id and no archive row; `adoptStagedAttachments` fills the
 * link in the moment the message is filed, on every path that files one.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { id, now, queueIndexJob, USER_ID } from "./db.ts";
import type { AttachmentRow, Db } from "./types.ts";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The content types a stored picture can have: what a browser draws and the vision model reads. */
export function storableType(type: string): boolean {
  return type in EXTENSIONS;
}

let scratchDir: string | undefined;

/**
 * Where the files go: `ATTACHMENTS_DIR`, else `attachments/` beside the
 * database file. An in-memory database (tests) has no neighbour, so it gets a
 * directory of its own under the system temp directory.
 */
export function attachmentsDir(db: Db): string {
  const configured = process.env.ATTACHMENTS_DIR?.trim();
  if (configured) return resolve(configured);
  if (!db.name || db.name === ":memory:") {
    scratchDir ??= join(tmpdir(), `fieldnote-attachments-${process.pid}`);
    return scratchDir;
  }
  return join(dirname(resolve(db.name)), "attachments");
}

/** The path of an attachment's file. The name comes from the row, never from a request. */
export function attachmentPath(db: Db, row: Pick<AttachmentRow, "file_name">): string {
  return join(attachmentsDir(db), basename(row.file_name));
}

export type StagedPicture = { row: AttachmentRow; bytes: Buffer };

/**
 * Writes a downloaded picture to disk and files its row against the inbound
 * message's provider id. Repeating it for the same message and link returns the
 * row already there, so a retried turn never stores a picture twice. A picture
 * whose bytes match one already on disk shares that file.
 */
export function stageAttachment(db: Db, input: {
  threadId: string;
  providerMessageId?: string;
  sourceUrl: string;
  contentType: string;
  bytes: Buffer;
}): AttachmentRow {
  const existing = db.prepare(`
    SELECT * FROM attachments WHERE thread_id=? AND COALESCE(provider_message_id,'')=? AND source_url=?
  `).get(input.threadId, input.providerMessageId ?? "", input.sourceUrl) as AttachmentRow | undefined;
  if (existing && existsSync(attachmentPath(db, existing))) return existing;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const shared = db.prepare("SELECT file_name FROM attachments WHERE sha256=? AND id<>? LIMIT 1")
    .get(sha256, existing?.id ?? "") as { file_name: string } | undefined;
  const attachmentId = existing?.id ?? id("attachment");
  const fileName = shared && existsSync(join(attachmentsDir(db), basename(shared.file_name)))
    ? shared.file_name
    : `${attachmentId}.${EXTENSIONS[input.contentType] ?? "bin"}`;
  const dir = attachmentsDir(db);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(fileName));
  if (!existsSync(target)) writeFileSync(target, input.bytes);
  if (existing) {
    db.prepare("UPDATE attachments SET file_name=?,content_type=?,byte_size=?,sha256=? WHERE id=?")
      .run(fileName, input.contentType, input.bytes.length, sha256, existing.id);
    return db.prepare("SELECT * FROM attachments WHERE id=?").get(existing.id) as AttachmentRow;
  }
  db.prepare(`
    INSERT INTO attachments(
      id,user_id,channel_message_id,thread_id,provider_message_id,source_url,content_type,byte_size,sha256,file_name,
      description,kind,created_at
    ) VALUES(?,?,NULL,?,?,?,?,?,?,?,NULL,'photo',?)
  `).run(
    attachmentId, USER_ID, input.threadId, input.providerMessageId ?? null, input.sourceUrl,
    input.contentType, input.bytes.length, sha256, fileName, now(),
  );
  // The message may already be filed (a retry after a restart), so link it now.
  adoptStagedAttachments(db, input.threadId, input.providerMessageId);
  return db.prepare("SELECT * FROM attachments WHERE id=?").get(attachmentId) as AttachmentRow;
}

/** Ties the staged pictures of an inbound message to its archive row, once there is one. */
export function adoptStagedAttachments(db: Db, threadId: string, providerMessageId: string | undefined): void {
  if (!providerMessageId) return;
  const message = db.prepare(`
    SELECT id FROM channel_messages WHERE thread_id=? AND direction='inbound' AND provider_message_id=?
  `).get(threadId, providerMessageId) as { id: string } | undefined;
  if (!message) return;
  db.prepare(`
    UPDATE attachments SET channel_message_id=?
    WHERE thread_id=? AND provider_message_id=? AND channel_message_id IS NULL
  `).run(message.id, threadId, providerMessageId);
}

const WITH_AREA = `
  SELECT a.*,la.id life_area_id,la.name life_area_name FROM attachments a
  LEFT JOIN life_areas la ON la.thread_id=a.thread_id
`;

export function getAttachment(db: Db, attachmentId: string): AttachmentRow | undefined {
  return db.prepare(`${WITH_AREA} WHERE a.id=? AND a.user_id=?`).get(attachmentId, USER_ID) as AttachmentRow | undefined;
}

/** The pictures filed under one archived message, in the order they were sent. */
export function attachmentsForMessage(db: Db, messageId: string): AttachmentRow[] {
  return db.prepare(`${WITH_AREA} WHERE a.channel_message_id=? ORDER BY a.created_at,a.rowid`).all(messageId) as AttachmentRow[];
}

/** The stored copy of a message's picture, by the link it arrived on. */
export function attachmentForLink(db: Db, messageId: string, sourceUrl: string): AttachmentRow | undefined {
  return db.prepare(`${WITH_AREA} WHERE a.channel_message_id=? AND a.source_url=?`)
    .get(messageId, sourceUrl) as AttachmentRow | undefined;
}

/** The bytes of a stored picture, or nothing when the file has gone missing. */
export function readAttachment(db: Db, row: AttachmentRow): Buffer | undefined {
  try {
    return readFileSync(attachmentPath(db, row));
  } catch {
    return undefined;
  }
}

/** Records what the vision model made of a picture, and whether it was a document. */
export function setAttachmentDescription(
  db: Db,
  attachmentId: string,
  description: string,
  kind: "photo" | "document",
): void {
  db.transaction(() => {
    db.prepare("UPDATE attachments SET description=?,kind=? WHERE id=?").run(description, kind, attachmentId);
    for (const memoryId of memoriesOf(db, attachmentId)) queueIndexJob(db, "memory", memoryId);
  })();
}

function memoriesOf(db: Db, attachmentId: string): string[] {
  return (db.prepare("SELECT memory_id FROM memory_attachments WHERE attachment_id=?").all(attachmentId) as Array<{ memory_id: string }>)
    .map(row => row.memory_id);
}

export function attachmentsForMemory(db: Db, memoryId: string): AttachmentRow[] {
  return db.prepare(`
    ${WITH_AREA} JOIN memory_attachments ma ON ma.attachment_id=a.id
    WHERE ma.memory_id=? ORDER BY a.created_at,a.rowid
  `).all(memoryId) as AttachmentRow[];
}

/** One query for a page of memories: their attachments, keyed by memory id. */
export function attachmentsForMemories(db: Db, memoryIds: string[]): Map<string, AttachmentRow[]> {
  const byMemory = new Map<string, AttachmentRow[]>();
  if (!memoryIds.length) return byMemory;
  const rows = db.prepare(`
    SELECT a.*,la.id life_area_id,la.name life_area_name,ma.memory_id FROM attachments a
    JOIN memory_attachments ma ON ma.attachment_id=a.id
    LEFT JOIN life_areas la ON la.thread_id=a.thread_id
    WHERE ma.memory_id IN (${memoryIds.map(() => "?").join(",")})
    ORDER BY a.created_at,a.rowid
  `).all(...memoryIds) as Array<AttachmentRow & { memory_id: string }>;
  for (const { memory_id, ...row } of rows) {
    const list = byMemory.get(memory_id) ?? [];
    list.push(row);
    byMemory.set(memory_id, list);
  }
  return byMemory;
}

/**
 * Attaches pictures to a memory. Only pictures from `threadId`, the thread the
 * turn is answering, are linked: a turn can no more attach another chat's
 * photo than read another chat's memory. Returns how many were newly linked.
 */
export function linkMemoryAttachments(db: Db, memoryId: string, attachmentIds: string[], threadId: string): number {
  if (!attachmentIds.length) return 0;
  let linked = 0;
  const insert = db.prepare("INSERT OR IGNORE INTO memory_attachments(memory_id,attachment_id,created_at) VALUES(?,?,?)");
  for (const attachmentId of new Set(attachmentIds)) {
    const own = db.prepare("SELECT 1 found FROM attachments WHERE id=? AND thread_id=? AND user_id=?")
      .get(attachmentId, threadId, USER_ID);
    if (own) linked += insert.run(memoryId, attachmentId, now()).changes;
  }
  if (linked) queueIndexJob(db, "memory", memoryId);
  return linked;
}

/** The attachment descriptions of a memory as one searchable string. */
export function attachmentTextForMemory(db: Db, memoryId: string): string {
  return attachmentsForMemory(db, memoryId)
    .map(row => row.description?.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Removes a picture: its row, its links, and its file unless another row still
 * shares the bytes. The memories that showed it are reindexed.
 */
export function deleteAttachment(db: Db, attachmentId: string): boolean {
  const row = getAttachment(db, attachmentId);
  if (!row) return false;
  const memoryIds = memoriesOf(db, attachmentId);
  db.transaction(() => {
    db.prepare("DELETE FROM attachments WHERE id=?").run(attachmentId);
    for (const memoryId of memoryIds) queueIndexJob(db, "memory", memoryId);
  })();
  removeFileIfUnused(db, row.file_name);
  return true;
}

function removeFileIfUnused(db: Db, fileName: string): void {
  if (db.prepare("SELECT 1 found FROM attachments WHERE file_name=? LIMIT 1").get(fileName)) return;
  rmSync(join(attachmentsDir(db), basename(fileName)), { force: true });
}

const OWN_FILE = /^attachment_[0-9a-f-]{36}\.(?:jpg|png|gif|webp|bin)$/;

/**
 * Deletes files no row names any more: a message deleted with its thread takes
 * its rows with it but not its files. Safe to repeat.
 */
export function sweepOrphanedAttachmentFiles(db: Db): number {
  const dir = attachmentsDir(db);
  if (!existsSync(dir)) return 0;
  const named = new Set((db.prepare("SELECT file_name FROM attachments").all() as Array<{ file_name: string }>)
    .map(row => row.file_name));
  let removed = 0;
  for (const file of readdirSync(dir)) {
    // Only files this module wrote: the directory may be one the operator shares.
    if (named.has(file) || !OWN_FILE.test(file)) continue;
    rmSync(join(dir, file), { force: true });
    removed += 1;
  }
  return removed;
}

export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/file`;
}

/** What the REST API and the agent's tools return for a picture. */
export function attachmentJson(row: AttachmentRow, memoryIds?: string[]): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    content_type: row.content_type,
    byte_size: row.byte_size,
    url: attachmentUrl(row.id),
    life_area_id: row.life_area_id ?? null,
    life_area_name: row.life_area_name ?? null,
    created_at: row.created_at,
    ...(memoryIds ? { memory_ids: memoryIds } : {}),
  };
}
