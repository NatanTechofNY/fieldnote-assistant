import type { Attachment } from "../../types";

/**
 * A short label for a picture, for what a screen reader or a tooltip says. The
 * full reading of it sits in text beside the large picture, so it is not
 * repeated as the image's alt text.
 */
export function pictureLabel(attachment: Attachment): string {
  const what = attachment.kind === "document" ? "document" : "picture";
  const day = attachment.created_at ? new Date(attachment.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  return day ? `Saved ${what} from ${day}` : `Saved ${what}`;
}
