import { z } from "zod";
import { existsSync } from "node:fs";
import { attachmentJson, attachmentPath, deleteAttachment, getAttachment } from "../attachments.ts";
import { USER_ID } from "../db.ts";
import { failure, success } from "../http.ts";
import { iso } from "../schemas.ts";
import type { AttachmentRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

/**
 * The pictures texted to the assistant, kept on disk. Registered after the
 * auth gate like every other route: a receipt is personal data, so the file
 * is served only to a signed-in session, and nothing here is exempt.
 */
export function registerAttachmentRoutes({ app, db }: RouteContext): void {
  app.get("/api/attachments", (req, res) => {
    const query = z.object({
      kind: z.enum(["photo", "document"]).optional(),
      /** A `created_at` to page back from: only pictures older than it are returned. */
      before: iso.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(60),
    }).parse(req.query);
    const rows = db.prepare(`
      SELECT a.*,la.id life_area_id,la.name life_area_name FROM attachments a
      LEFT JOIN life_areas la ON la.thread_id=a.thread_id
      WHERE a.user_id=@user_id
        -- A picture is listed once the message that carried it is filed.
        AND a.channel_message_id IS NOT NULL
        ${query.kind ? "AND a.kind=@kind" : ""}
        ${query.before ? "AND a.created_at<@before" : ""}
      ORDER BY a.created_at DESC,a.rowid DESC LIMIT @limit
    `).all({
      user_id: USER_ID,
      limit: query.limit,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.before ? { before: query.before } : {}),
    }) as AttachmentRow[];
    const links = rows.length
      ? db.prepare(`
        SELECT attachment_id,memory_id FROM memory_attachments
        WHERE attachment_id IN (${rows.map(() => "?").join(",")})
      `).all(...rows.map(row => row.id)) as Array<{ attachment_id: string; memory_id: string }>
      : [];
    const memoriesOf = (attachmentId: string) =>
      links.filter(link => link.attachment_id === attachmentId).map(link => link.memory_id);
    return success(res, {
      attachments: rows.map(row => attachmentJson(row, memoriesOf(row.id))),
      next_before: rows.length === query.limit ? rows[rows.length - 1].created_at : null,
    });
  });

  app.get("/api/attachments/:id/file", (req, res) => {
    const row = getAttachment(db, req.params.id);
    const path = row ? attachmentPath(db, row) : undefined;
    if (!row || !path || !existsSync(path)) return failure(res, 404, "Attachment not found");
    // Stored bytes are served as the type they were verified as, never sniffed
    // into something a browser would run.
    res.setHeader("Content-Type", row.content_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    return res.sendFile(path, { dotfiles: "allow" });
  });

  app.delete("/api/attachments/:id", (req, res) => {
    if (!deleteAttachment(db, req.params.id)) return failure(res, 404, "Attachment not found");
    return success(res, { id: req.params.id });
  });
}
