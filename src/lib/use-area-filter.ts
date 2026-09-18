import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  LifeArea,
} from "../types";
import { hasGroupAreas, initialAreaFilter, MY_ITEMS } from "./area-filter";

const PREFIX = "fieldnote:";

/**
 * The area filter a page is wearing, remembered between visits the way the
 * view and the show-done switch are: which list you work from is a habit.
 *
 * Two things override what was remembered. A link to a specific record opens
 * wide for that visit, since the record may be a group's, and is not
 * remembered. And a remembered choice that no longer exists — an area since
 * deleted, or "My items" once the last group chat's area is gone — is read as
 * the fallback rather than leaving the page filtering on nothing. That check
 * is made against the loaded areas on every render, so nothing has to be
 * written back for the page to be right.
 */
export function useAreaFilter(key: string, areas: LifeArea[], areasLoaded: boolean): [string, (next: string) => void] {
  const [searchParams] = useSearchParams();
  const [chosen, setChosen] = useState<string>(() => {
    if (searchParams.has("open")) return initialAreaFilter(searchParams);
    try {
      return window.localStorage.getItem(PREFIX + key) ?? MY_ITEMS;
    } catch {
      return MY_ITEMS;
    }
  });
  const update = useCallback((next: string) => {
    setChosen(next);
    try {
      window.localStorage.setItem(PREFIX + key, next);
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
    }
  }, [key]);
  if (!areasLoaded) return [chosen, update];
  const known = !chosen
    || (chosen === MY_ITEMS ? hasGroupAreas(areas) : areas.some(area => area.id === chosen));
  return [known ? chosen : hasGroupAreas(areas) ? MY_ITEMS : "", update];
}
