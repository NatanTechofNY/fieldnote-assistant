import type { PageAudience, PageBlock, PageKind } from "../pages.ts";
import type { Db } from "../types.ts";

/** Where a page is being made: a group's area when it is for a group, otherwise the owner's own. */
export type TemplateScope = {
  lifeAreaId: string | null;
  threadId: string | null;
  groupId: string | null;
  groupName: string | null;
};

/** The few inputs a template can use; each one documents which of them it reads. */
export type TemplateParams = {
  title?: string | null;
  items?: string[] | null;
  slots?: string[] | null;
  when?: string | null;
  todo_id?: string | null;
  closes_at?: string | null;
};

export type TemplateResult = {
  title: string;
  blocks: PageBlock[];
  kind?: PageKind;
  audience: PageAudience;
  expiresInDays?: number;
  /** The template wrote todos, so the caller flushes the search outbox. */
  wroteTodos?: boolean;
};

export type TemplateBuilder = (db: Db, scope: TemplateScope, params: TemplateParams) => TemplateResult | Promise<TemplateResult>;

/** What a template that is for the group, or for the owner alone, is. */
export const groupAudience = (scope: TemplateScope) => (scope.lifeAreaId ? "shared" as const : "owner" as const);
