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

/** Whether any area belongs to a group chat; without one, "My items" and "All areas" are the same list. */
export function hasGroupAreas(areas: LifeArea[]): boolean {
  return areas.some(area => area.is_group);
}

/**
 * Where a page's area filter starts. My items, unless the page was opened by a
 * link to a specific record (`?open=<id>`): the link is to that record, which
 * may be a group's, and a filter that hid it would defeat the link.
 */
export function initialAreaFilter(searchParams: URLSearchParams): string {
  return searchParams.has("open") ? "" : MY_ITEMS;
}

/** Whether a record filed under `lifeAreaId` (null for none) is shown by `value`. */
export function inAreaFilter(value: string, areas: LifeArea[], lifeAreaId: string | null | undefined): boolean {
  if (!value) return true;
  if (value === MY_ITEMS) {
    return !lifeAreaId || !areas.some(area => area.id === lifeAreaId && area.is_group);
  }
  return lifeAreaId === value;
}

/**
 * What to ask the server for. A specific area is a `life_area_id`; "My items"
 * is `scope: "mine"`, applied in SQL so the row limit is spent on the owner's
 * own records rather than on a busy chat's that would then be dropped here.
 * `inAreaFilter()` is still applied to what comes back, so a stale cache entry
 * fetched under another filter never shows the wrong rows.
 */
export function areaFilterParams(value: string): { life_area_id?: string; scope?: "mine" } {
  if (value === MY_ITEMS) return { scope: "mine" };
  return value ? { life_area_id: value } : {};
}
