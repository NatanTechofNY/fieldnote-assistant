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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    if (!scratchDir) {
      const dir = join(tmpdir(), `fieldnote-attachments-${process.pid}`);
      // Nothing outlives a process that had no database file to sit beside.
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      scratchDir = dir;
    }
    return scratchDir;
  }
  return join(dirname(resolve(db.name)), "attachments");
}

/** The path of an attachment's file. The name comes from the row, never from a request. */
export function attachmentPath(db: Db, row: Pick<AttachmentRow, "file_name">): string {
  return join(attachmentsDir(db), basename(row.file_name));
}

function fileIntact(path: string, size: number): boolean {
  try {
    return statSync(path).size === size;
  } catch {
    return false;
  }
}

/** Whether a row's file is on disk at the size the row recorded: a truncated copy is as good as none. */
export function attachmentFileIntact(db: Db, row: Pick<AttachmentRow, "file_name" | "byte_size">): boolean {
  return fileIntact(attachmentPath(db, row), row.byte_size);
}

/**
 * Written under a name of its own and renamed into place, so a crash or a full
 * disk mid-write leaves a stray partial file rather than a short picture under
 * the name a row will carry.
 */
function writeFileAtomically(target: string, bytes: Buffer): void {
  const partial = `${target}.${process.pid}.part`;
  try {
    writeFileSync(partial, bytes);
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/** `ATTACHMENTS_MAX_MB`: the most the kept pictures may total, or no limit when it is unset or 0. */
export function attachmentsCapBytes(): number {
  const megabytes = Number(process.env.ATTACHMENTS_MAX_MB?.trim());
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.floor(megabytes * 1024 * 1024) : 0;
}

/** What the kept pictures add up to. A file shared by two rows counts twice, which only errs on the safe side. */
export function attachmentsBytes(db: Db): number {
  return (db.prepare("SELECT COALESCE(SUM(byte_size),0) total FROM attachments").get() as { total: number }).total;
}

/** Whether `incoming` more bytes would take the kept pictures past the cap. */
export function attachmentsFull(db: Db, incoming: number): boolean {
  const cap = attachmentsCapBytes();
  return cap > 0 && attachmentsBytes(db) + incoming > cap;
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
  // A row whose file has gone, or been cut short, is repaired from these bytes.
  if (existing && attachmentFileIntact(db, existing)) return existing;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const dir = attachmentsDir(db);
  const shared = db.prepare("SELECT file_name,byte_size FROM attachments WHERE sha256=? AND id<>? LIMIT 1")
    .get(sha256, existing?.id ?? "") as { file_name: string; byte_size: number } | undefined;
  const attachmentId = existing?.id ?? id("attachment");
  const fileName = shared && fileIntact(join(dir, basename(shared.file_name)), shared.byte_size)
    ? shared.file_name
    : `${attachmentId}.${EXTENSIONS[input.contentType] ?? "bin"}`;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(fileName));
  const wrote = !fileIntact(target, input.bytes.length);
  if (wrote) writeFileAtomically(target, input.bytes);
  try {
    if (existing) {
      db.prepare("UPDATE attachments SET file_name=?,content_type=?,byte_size=?,sha256=? WHERE id=?")
        .run(fileName, input.contentType, input.bytes.length, sha256, existing.id);
    } else {
      db.prepare(`
        INSERT INTO attachments(
          id,user_id,channel_message_id,thread_id,provider_message_id,source_url,content_type,byte_size,sha256,file_name,
          description,kind,created_at
        ) VALUES(?,?,NULL,?,?,?,?,?,?,?,NULL,'photo',?)
      `).run(
        attachmentId, USER_ID, input.threadId, input.providerMessageId ?? null, input.sourceUrl,
        input.contentType, input.bytes.length, sha256, fileName, now(),
      );
    }
  } catch (error) {
    // A file nothing names is only clutter until the next sweep; do not wait for it.
    if (wrote) removeFileIfUnused(db, fileName);
    throw error;
  }
  // The message may already be filed (a retry after a restart), so link it now.
  adoptStagedAttachments(db, input.threadId, input.providerMessageId, undefined, input.sourceUrl);
  return db.prepare("SELECT * FROM attachments WHERE id=?").get(attachmentId) as AttachmentRow;
}

/**
 * Ties the staged pictures of an inbound message to its archive row, once there
 * is one. A provider that sent no message id leaves nothing to match on, so
 * those are tied by the links the filed message carries: from `messageId` when
 * the caller has just filed it, or from `sourceUrl` when a picture is staged
 * after its message was.
 */
export function adoptStagedAttachments(
  db: Db,
  threadId: string,
  providerMessageId: string | undefined,
  messageId?: string,
  sourceUrl?: string,
): void {
  if (providerMessageId) {
    const message = db.prepare(`
      SELECT id FROM channel_messages WHERE thread_id=? AND direction='inbound' AND provider_message_id=?
    `).get(threadId, providerMessageId) as { id: string } | undefined;
    if (!message) return;
    db.prepare(`
      UPDATE attachments SET channel_message_id=?
      WHERE thread_id=? AND provider_message_id=? AND channel_message_id IS NULL
    `).run(message.id, threadId, providerMessageId);
    return;
  }
  const target = messageId ?? (sourceUrl
    ? (db.prepare(`
      SELECT id FROM channel_messages
      WHERE thread_id=? AND direction='inbound' AND provider_message_id IS NULL
        AND EXISTS (SELECT 1 FROM json_each(channel_messages.metadata_json,'$.mediaUrls') WHERE value=?)
      ORDER BY created_at DESC,rowid DESC LIMIT 1
    `).get(threadId, sourceUrl) as { id: string } | undefined)?.id
    : undefined);
  if (!target) return;
  const links = db.prepare("SELECT value FROM json_each((SELECT metadata_json FROM channel_messages WHERE id=?),'$.mediaUrls')")
    .all(target) as Array<{ value: string }>;
  if (!links.length) return;
  db.prepare(`
    UPDATE attachments SET channel_message_id=?
    WHERE thread_id=? AND provider_message_id IS NULL AND channel_message_id IS NULL
      AND source_url IN (${links.map(() => "?").join(",")})
  `).run(target, threadId, ...links.map(link => link.value));
}

/**
 * Keeps a picture that was fetched while its message was being read, because
 * staging it on arrival had failed. It is filed against that message directly.
 */
export function stageForMessage(
  db: Db,
  messageId: string,
  sourceUrl: string,
  picture: { type: string; bytes: Buffer },
): AttachmentRow | undefined {
  const message = db.prepare("SELECT thread_id,provider_message_id FROM channel_messages WHERE id=?")
    .get(messageId) as { thread_id: string; provider_message_id: string | null } | undefined;
  if (!message || !storableType(picture.type)) return undefined;
  const row = stageAttachment(db, {
    threadId: message.thread_id,
    providerMessageId: message.provider_message_id ?? undefined,
    sourceUrl,
    contentType: picture.type,
    bytes: picture.bytes,
  });
  db.prepare("UPDATE attachments SET channel_message_id=? WHERE id=? AND channel_message_id IS NULL").run(messageId, row.id);
  return getAttachment(db, row.id);
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

/**
 * A picture belongs to the chat that sent it, and a memory to the area it is
 * filed under. They may be kept together only when those are the same chat: a
 * group's pictures with its own area's memories, and the owner's private ones
 * with memories in no group's area. Checked when a picture is linked and again
 * whenever one is read, so a memory moved into a group's area (or filed there
 * from a private chat) never shows the owner's private pictures or their text
 * to the group. `la` is the picture's group area, if its chat is a group.
 */
const SAME_CHAT = `COALESCE((
  SELECT filed.thread_id FROM memories mem JOIN life_areas filed ON filed.id=mem.life_area_id WHERE mem.id=ma.memory_id
),'')=COALESCE(la.thread_id,'')`;

export function attachmentsForMemory(db: Db, memoryId: string): AttachmentRow[] {
  return db.prepare(`
    ${WITH_AREA} JOIN memory_attachments ma ON ma.attachment_id=a.id
    WHERE ma.memory_id=? AND ${SAME_CHAT} ORDER BY a.created_at,a.rowid
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
    WHERE ma.memory_id IN (${memoryIds.map(() => "?").join(",")}) AND ${SAME_CHAT}
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
 * turn is answering, are linked, and only when that chat and the memory's area
 * are the same (see `SAME_CHAT`): a turn can no more attach another chat's
 * photo than read another chat's memory, and a private chat's pictures are not
 * handed to a group by filing a memory under the group's area. Returns how many
 * were newly linked.
 */
export function linkMemoryAttachments(db: Db, memoryId: string, attachmentIds: string[], threadId: string): number {
  if (!attachmentIds.length) return 0;
  const filed = db.prepare(`
    SELECT filed.thread_id area_thread FROM memories m LEFT JOIN life_areas filed ON filed.id=m.life_area_id WHERE m.id=?
  `).get(memoryId) as { area_thread: string | null } | undefined;
  if (!filed) return 0;
  let linked = 0;
  const insert = db.prepare("INSERT OR IGNORE INTO memory_attachments(memory_id,attachment_id,created_at) VALUES(?,?,?)");
  for (const attachmentId of new Set(attachmentIds)) {
    const own = db.prepare(`
      SELECT 1 found FROM attachments a LEFT JOIN life_areas la ON la.thread_id=a.thread_id
      WHERE a.id=? AND a.thread_id=? AND a.user_id=? AND COALESCE(la.thread_id,'')=?
    `).get(attachmentId, threadId, USER_ID, filed.area_thread ?? "");
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
 * SQL that is true when a picture kept with memory `memory` (a table alias)
 * says something matching `pattern` (a bound LIKE parameter). It is the lexical
 * counterpart of the `attachment_text` the search index carries, for an install
 * without Algolia, and honours the same chat-and-area rule as `SAME_CHAT`.
 */
export function pictureTextMatch(memory: string, pattern: string): string {
  return `EXISTS (
    SELECT 1 FROM memory_attachments pma JOIN attachments pa ON pa.id=pma.attachment_id
    WHERE pma.memory_id=${memory}.id AND lower(COALESCE(pa.description,'')) LIKE lower(${pattern}) ESCAPE '\\'
      AND COALESCE((SELECT filed.thread_id FROM life_areas filed WHERE filed.id=${memory}.life_area_id),'')
        = COALESCE((SELECT sent.thread_id FROM life_areas sent WHERE sent.thread_id=pa.thread_id),'')
  )`;
}

/** `ATTACHMENT_TEXT_INDEX=off` keeps what the pictures say out of the search index, for a deployment that would rather not send it. */
export function attachmentTextIndexed(): boolean {
  return process.env.ATTACHMENT_TEXT_INDEX?.trim().toLowerCase() !== "off";
}

/** What replaces a deleted picture's description in the conversation: the picture is still known to have been sent. */
export const DELETED_PICTURE_LINE = "[Picture attached — deleted]";

/**
 * Takes a picture's description out of the conversation it was archived in. The
 * line the agent read (`[Image: …]`, `[Image (document): …]`) is in the message
 * and in the `view_image` tool row beside it, and the message is in the search
 * index, so deleting the picture alone would leave the figures behind.
 */
function scrubDescription(db: Db, row: AttachmentRow): void {
  const description = row.description?.trim();
  if (!description) return;
  const lines = [`[Image: ${description}]`, `[Image (document): ${description}]`];
  const jsonText = (text: string) => JSON.stringify(text).slice(1, -1);
  const rewrite = (text: string, forms: (line: string) => string, placeholder: string) =>
    lines.reduce((current, line) => current.split(forms(line)).join(placeholder), text);
  const messages = db.prepare(`
    SELECT id,role,content,metadata_json FROM channel_messages
    WHERE thread_id=? AND (instr(content,?)>0 OR instr(metadata_json,?)>0)
  `).all(row.thread_id, description, jsonText(description)) as Array<{ id: string; role: string; content: string; metadata_json: string }>;
  for (const message of messages) {
    const content = rewrite(message.content, line => line, DELETED_PICTURE_LINE);
    // A tool row also carries the description bare, as the `attachments` of the memory it saved.
    const metadata = rewrite(message.metadata_json, jsonText, jsonText(DELETED_PICTURE_LINE))
      .split(jsonText(description)).join("(deleted)");
    if (content === message.content && metadata === message.metadata_json) continue;
    db.prepare("UPDATE channel_messages SET content=?,metadata_json=?,updated_at=? WHERE id=?").run(content, metadata, now(), message.id);
    if (message.role === "user" || message.role === "assistant") queueIndexJob(db, "channel_message", message.id);
  }
}

/**
 * Removes a picture: its row, its links, and its file unless another row still
 * shares the bytes, and what the assistant read off it wherever the
 * conversation archived that. The memories that showed it are reindexed. A
 * memory's own text, which the assistant wrote, is the memory's to edit.
 */
export function deleteAttachment(db: Db, attachmentId: string): boolean {
  const row = getAttachment(db, attachmentId);
  if (!row) return false;
  const memoryIds = memoriesOf(db, attachmentId);
  db.transaction(() => {
    db.prepare("DELETE FROM attachments WHERE id=?").run(attachmentId);
    for (const memoryId of memoryIds) queueIndexJob(db, "memory", memoryId);
    scrubDescription(db, row);
  })();
  removeFileIfUnused(db, row.file_name);
  return true;
}

function removeFileIfUnused(db: Db, fileName: string): void {
  if (db.prepare("SELECT 1 found FROM attachments WHERE file_name=? LIMIT 1").get(fileName)) return;
  rmSync(join(attachmentsDir(db), basename(fileName)), { force: true });
}

const OWN_FILE = /^attachment_[0-9a-f-]{36}\.(?:jpg|png|gif|webp|bin)$/;
/** What `writeFileAtomically` leaves behind if the process dies between the write and the rename. */
const PARTIAL_FILE = /^attachment_[0-9a-f-]{36}\.(?:jpg|png|gif|webp|bin)\.\d+\.part$/;
/** A file this young may belong to a write in progress, or to a database about to be restored beside it. */
const ORPHAN_GRACE_MS = 24 * 60 * 60_000;

/**
 * Deletes files no row names any more: a message deleted with its thread takes
 * its rows with it but not its files. Safe to repeat. A file younger than
 * `graceMs` (a day by default) is left alone, so a database restored from an
 * older backup beside newer pictures does not lose them to the next start;
 * `reset` passes 0, because it has just emptied every row on purpose.
 */
export function sweepOrphanedAttachmentFiles(db: Db, options: { graceMs?: number } = {}): number {
  const dir = attachmentsDir(db);
  if (!existsSync(dir)) return 0;
  const graceMs = options.graceMs ?? ORPHAN_GRACE_MS;
  const named = new Set((db.prepare("SELECT file_name FROM attachments").all() as Array<{ file_name: string }>)
    .map(row => row.file_name));
  let removed = 0;
  for (const file of readdirSync(dir)) {
    // Only files this module wrote: the directory may be one the operator shares.
    if (named.has(file) || !(OWN_FILE.test(file) || PARTIAL_FILE.test(file))) continue;
    const path = join(dir, file);
    if (graceMs > 0) {
      try {
        if (Date.now() - statSync(path).mtimeMs < graceMs) continue;
      } catch {
        continue;
      }
    }
    rmSync(path, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Drops the rows of pictures whose message never got filed: an event that gave
 * up between staging and archiving. The gallery lists only filed pictures, so
 * nothing else could ever show or delete them.
 */
export function dropUnadoptedAttachments(db: Db, olderThanMs = ORPHAN_GRACE_MS): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = db.prepare("SELECT id,file_name FROM attachments WHERE channel_message_id IS NULL AND created_at<?")
    .all(cutoff) as Array<{ id: string; file_name: string }>;
  for (const row of rows) {
    db.prepare("DELETE FROM attachments WHERE id=?").run(row.id);
    removeFileIfUnused(db, row.file_name);
  }
  return rows.length;
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
