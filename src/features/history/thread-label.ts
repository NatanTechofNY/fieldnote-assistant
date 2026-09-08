import type {
  ChannelConversation,
} from "../../types";

/** Threads keyed on an iMessage group rather than a phone number. */
const GROUP_ADDRESS_PREFIX = "group:";

export function isGroupAddress(address: string): boolean {
  return address.startsWith(GROUP_ADDRESS_PREFIX);
}

/**
 * `digest:` and `reflection:` threads hold app-composed drafts, not real chats;
 * a `group:` thread is a real chat with several people in it, titled by the
 * name the group was given rather than by an id nobody recognises.
 */
export function threadLabel(
  address: string,
  displayName?: string | null,
): { title: string; subtitle: string; eyebrow: string } | null {
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
  if (isGroupAddress(address)) {
    return {
      title: displayName ? `Group chat · ${displayName}` : "Group chat",
      subtitle: "A shared iMessage chat; each message names who sent it",
      eyebrow: "Group chat",
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
  thread: Pick<ChannelConversation, "address" | "channel"> & Partial<Pick<ChannelConversation, "displayName">>,
  formatAddress: (address: string) => string = address => address,
  webTitle = "Web agent",
) {
  return threadLabel(thread.address, thread.displayName)?.title
    ?? (thread.channel === "sms" ? 'Text Messages (' + formatAddress(thread.address) + ')' : webTitle);
}
