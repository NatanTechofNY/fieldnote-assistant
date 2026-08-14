import type {
  ChannelConversation,
} from "../../types";

/** `digest:` and `reflection:` threads hold app-composed drafts, not real chats. */
export function threadLabel(address: string): { title: string; subtitle: string; eyebrow: string } | null {
  if (address.startsWith("reflection:")) {
    return {
      title: "Reflection generator",
      subtitle: "Generated from selected evidence",
      eyebrow: "Agent workflow",
    };
  }
  if (address.startsWith("digest:")) {
    return {
      title: "Digest drafts",
      subtitle: "Where digests and briefs are written before they are texted",
      eyebrow: "Agent workflow",
    };
  }
  return null;
}

/**
 * What to call a thread in a list, where there is room for one line. The address
 * passes through `formatAddress` so demo mode can mask the number without this
 * having to know the setting exists.
 */
export function threadTitle(
  thread: Pick<ChannelConversation, "address" | "channel">,
  formatAddress: (address: string) => string = address => address,
) {
  return threadLabel(thread.address)?.title
    ?? (thread.channel === "sms" ? 'Text Messages (' + formatAddress(thread.address) + ')' : "Web agent");
}
