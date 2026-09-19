import { NO_TEXT_FALLBACK } from "../agent-runner.ts";
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
 * build on what came before. The thread is keyed on the verified area, never
 * on the request, so there is one per ask rather than one per spelling.
 */
export function registerCheckinRoutes({ app, db, draftWithAgent }: RouteContext): void {
  app.post("/api/checkins/draft-ask", async (req, res) => {
    const body = askDraftInput.parse(req.body);
    let group: { id: string; name: string } | undefined;
    if (body.kind !== "owner_evening") {
      const area = db.prepare("SELECT id,name,thread_id FROM life_areas WHERE id=? AND user_id=?").get(body.life_area_id, USER_ID) as
        | { id: string; name: string; thread_id: string | null }
        | undefined;
      if (!area) return failure(res, 404, "Life area not found");
      if (!area.thread_id) return failure(res, 400, "Only a group chat's area has check-ins");
      group = { id: area.id, name: area.name };
    }
    const prompt = composeAskDraftTurn({ kind: body.kind, brief: body.brief, groupName: group?.name, current: body.current });
    const label = body.kind === "group_morning" ? `Morning note for ${group?.name}`
      : body.kind === "group_evening" ? `Evening question for ${group?.name}`
        : "My evening question";
    let text: string;
    try {
      text = await draftWithAgent(prompt, `checkin-ask:${body.kind}:${group?.id ?? "owner"}`, {
        context: { kind: "checkin_ask_draft", briefName: label, instruction: body.brief },
      });
    } catch (error) {
      console.error("Drafting a check-in's wording failed:", error instanceof Error ? error.message : error);
      return failure(res, 502, "The agent could not draft the wording just now; try again in a moment");
    }
    // A model that quotes or pads anyway still hands back something pasteable;
    // one that produced no text at all (the runner's stand-in sentence) is a miss.
    const ask = text.trim().replace(/^["“]+|["”]+$/g, "").trim().slice(0, CHECKIN_PROMPT_MAX);
    if (!ask || ask === NO_TEXT_FALLBACK) return failure(res, 502, "The agent did not come back with any wording");
    return success(res, { ask });
  });
}
