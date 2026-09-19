import { CHECKIN_PROMPT_MAX, composeAskDraftTurn } from "../checkin-prompts.ts";
import { USER_ID } from "../db.ts";
import { failure, success } from "../http.ts";
import { askDraftInput } from "../schemas.ts";
import type { RouteContext } from "./context.ts";

/**
 * The agent helps write a check-in's ask. The owner says what the group is for
 * or how they want to be asked; the agent answers with the wording, which the
 * page puts in the field for the owner to read and save. Nothing is saved
 * here — a draft is a suggestion until "Save wording" — and the turn runs on
 * a scratch web thread per ask, like a reflection draft, so revisions can
 * build on what came before.
 */
export function registerCheckinRoutes({ app, db, draftWithAgent }: RouteContext): void {
  app.post("/api/checkins/draft-ask", async (req, res) => {
    const body = askDraftInput.parse(req.body);
    let groupName: string | undefined;
    if (body.kind !== "owner_evening") {
      const area = db.prepare("SELECT name,thread_id FROM life_areas WHERE id=? AND user_id=?").get(body.life_area_id, USER_ID) as
        | { name: string; thread_id: string | null }
        | undefined;
      if (!area) return failure(res, 404, "Life area not found");
      if (!area.thread_id) return failure(res, 400, "Only a group chat's area has check-ins");
      groupName = area.name;
    }
    const prompt = composeAskDraftTurn({ kind: body.kind, brief: body.brief, groupName, current: body.current });
    const label = body.kind === "group_morning" ? `Morning note for ${groupName}`
      : body.kind === "group_evening" ? `Evening question for ${groupName}`
        : "My evening question";
    const text = await draftWithAgent(prompt, `checkin-ask:${body.kind}:${body.life_area_id ?? "owner"}`, {
      context: { kind: "checkin_ask_draft", briefName: label, instruction: body.brief },
    });
    // A model that quotes or pads anyway still hands back something pasteable.
    const ask = text.trim().replace(/^["“]+|["”]+$/g, "").trim().slice(0, CHECKIN_PROMPT_MAX);
    if (!ask) return failure(res, 502, "The agent did not come back with any wording");
    return success(res, { ask });
  });
}
