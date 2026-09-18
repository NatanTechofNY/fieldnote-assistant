import type {
  LifeArea,
} from "../types";

/**
 * The filter value for the owner's own records: everything not filed under a
 * group chat's area. A group's todos and memories are shared with the people
 * in that chat, and once a chat or two is busy they crowd out the owner's own
 * list, so this is where the board and the memories page open.
 */
export const MY_ITEMS = "mine";

/** Whether a record filed under `lifeAreaId` (null for none) is shown by `value`. */
export function inAreaFilter(value: string, areas: LifeArea[], lifeAreaId: string | null | undefined): boolean {
  if (!value) return true;
  if (value === MY_ITEMS) {
    return !lifeAreaId || !areas.some(area => area.id === lifeAreaId && area.is_group);
  }
  return lifeAreaId === value;
}

/** The area id to ask the server for; the two aggregate views are narrowed on the client. */
export function areaFilterParam(value: string): string | undefined {
  return value && value !== MY_ITEMS ? value : undefined;
}
