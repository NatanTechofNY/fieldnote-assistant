import { USER_ID, id, now } from "../db.ts";
import { failure, success } from "../http.ts";
import { getNotificationPreferences } from "../integrations.ts";
import { localParts } from "../local-time.ts";
import { digestBriefCreate, digestBriefPatch } from "../schemas.ts";
import type { DigestBriefRow } from "../types.ts";
import { briefJson, composeBriefTurn, getDigestBrief } from "../digest-briefs.ts";
import type { RouteContext } from "./context.ts";

export function registerDigestBriefRoutes({ app, db, draftWithAgent }: RouteContext): void {
  app.get("/api/digest-briefs", (_req, res) => {
    const rows = db.prepare(`
      SELECT * FROM digest_briefs WHERE user_id=? ORDER BY send_time,name
    `).all(USER_ID) as DigestBriefRow[];
    return success(res, rows.map(briefJson));
  });
  app.post("/api/digest-briefs", (req, res) => {
    const body = digestBriefCreate.parse(req.body);
    const briefId = id("brief");
    const timestamp = now();
    db.prepare(`
      INSERT INTO digest_briefs(
        id,user_id,name,prompt,send_time,resources_json,enabled,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      briefId, USER_ID, body.name, body.prompt, body.sendTime,
      JSON.stringify(body.resources), Number(body.enabled), timestamp, timestamp,
    );
    return success(res, briefJson(getDigestBrief(db, briefId) as DigestBriefRow), 201);
  });
  app.patch("/api/digest-briefs/:id", (req, res) => {
    const body = digestBriefPatch.parse(req.body);
    const current = getDigestBrief(db, req.params.id);
    if (!current) return failure(res, 404, "Digest brief not found");
    db.prepare(`
      UPDATE digest_briefs SET name=?,prompt=?,send_time=?,resources_json=?,enabled=?,updated_at=?
      WHERE id=? AND user_id=?
    `).run(
      body.name ?? current.name,
      body.prompt ?? current.prompt,
      body.sendTime ?? current.send_time,
      body.resources === undefined ? current.resources_json : JSON.stringify(body.resources),
      body.enabled === undefined ? current.enabled : Number(body.enabled),
      now(), current.id, USER_ID,
    );
    return success(res, briefJson(getDigestBrief(db, current.id) as DigestBriefRow));
  });
  /*
   * Runs the brief now and hands back the draft instead of texting it. Same
   * composed turn, same thread as a real send, so a preview exercises the pinned
   * catalog and the tool calls the scheduled send would make — the only thing it
   * skips is Twilio.
   */
  app.post("/api/digest-briefs/:id/test", async (req, res) => {
    const brief = getDigestBrief(db, req.params.id);
    if (!brief) return failure(res, 404, "Digest brief not found");
    const preferences = getNotificationPreferences(db);
    const local = localParts(new Date(), preferences.timezone);
    const prompt = await composeBriefTurn(db, brief, {
      date: local.date,
      timezone: preferences.timezone,
    });
    const text = await draftWithAgent(prompt, `digest:${preferences.recipientPhone || "preview"}`, {
      channel: "sms",
      context: {
        kind: "digest_brief",
        briefId: brief.id,
        briefName: brief.name,
        instruction: brief.prompt,
        date: local.date,
        preview: true,
      },
    });
    return success(res, { text, sent: false, date: local.date, timezone: preferences.timezone });
  });
  app.delete("/api/digest-briefs/:id", (req, res) => {
    const result = db.prepare("DELETE FROM digest_briefs WHERE id=? AND user_id=?")
      .run(req.params.id, USER_ID);
    return result.changes
      ? success(res, { id: req.params.id })
      : failure(res, 404, "Digest brief not found");
  });
}
