import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { algoliasearch } from "algoliasearch";
import {
  getChannelMessage, getMemory, getTodo, now, queueIndexJob, USER_ID,
} from "./db.ts";
import { getSearchPreferences } from "./integrations.ts";
import type { ChannelMessageRow, Db, EntityType, IndexJobRow } from "./types.ts";

type SearchRecord = Record<string, unknown> & { objectID: string };
type AlgoliaClient = ReturnType<typeof algoliasearch>;

/**
 * True for a turn the app composed itself rather than one the user wrote, which
 * `runChannelAgent` marks in the message metadata.
 */
function isInternalChannelMessage(row: ChannelMessageRow): boolean {
  try {
    return (JSON.parse(row.metadata_json) as { internal?: unknown }).internal === true;
  } catch {
    return false;
  }
}

/** The three searchable surfaces, named the way the UI refers to them. */
export type SearchEntityType = "todo" | "memory" | "message";

export const SEARCH_ENTITY_TYPES: SearchEntityType[] = ["todo", "memory", "message"];

/**
 * Only what a result row renders, so a palette keystroke does not pull whole
 * journal entries over the wire.
 */
const RETRIEVED_ATTRIBUTES: Record<SearchEntityType, string[]> = {
  todo: [
    "objectID", "title", "notes", "status", "priority", "due_at",
    "category_name", "life_area_name", "updated_at",
  ],
  memory: [
    "objectID", "title", "content", "kind", "mood_label", "mood_score",
    "tags", "category_name", "life_area_name", "occurred_at", "updated_at",
  ],
  message: ["objectID", "threadId", "channel", "role", "content", "created_at"],
};

export interface MemorySearchFilters {
  kind?: string;
  category_id?: string;
  life_area_id?: string;
  mood_label?: string;
  review_worthy?: boolean;
}

export interface AlgoliaOptions {
  client?: AlgoliaClient | null;
  todoIndex?: string;
  memoryIndex?: string;
  messageIndex?: string;
  settingsDirectory?: string;
}

export interface FlushResult {
  configured: boolean;
  processed: number;
  succeeded: number;
  failed: number;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Facet values are quoted in the filter string, so quotes must be escaped. */
const escapeFilterValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** Matches the chunk size the v5 batch helpers use internally. */
const BATCH_SIZE = 1000;

interface IndexBatch {
  indexName: string;
  operation: "save" | "delete";
  jobs: IndexJobRow[];
  records: SearchRecord[];
  objectIDs: string[];
}

export class AlgoliaSync {
  readonly db: Db;
  readonly todoIndex: string;
  readonly memoryIndex: string;
  readonly messageIndex: string;
  readonly client: AlgoliaClient | null;
  readonly settingsDirectory: string;
  /** Per-index memo of the `filterOnly(userId)` check, keyed by index name. */
  private userFilterConfigured = new Map<string, boolean>();

  constructor(db: Db, options: AlgoliaOptions = {}) {
    this.db = db;
    this.todoIndex = options.todoIndex || process.env.ALGOLIA_TODO_INDEX || "devcon_assistant_todos";
    this.memoryIndex = options.memoryIndex || process.env.ALGOLIA_MEMORY_INDEX || "devcon_assistant_memories";
    this.messageIndex = options.messageIndex || process.env.ALGOLIA_MESSAGE_INDEX || "devcon_assistant_messages";
    this.settingsDirectory = options.settingsDirectory
      || resolve(process.cwd(), "agent-studio/indices");
    this.client = "client" in options ? (options.client ?? null) : this.createClient();
    this.db.prepare(`
      UPDATE index_jobs SET status='failed',last_error='Interrupted before completion',
        available_at=?,updated_at=? WHERE status='processing'
    `).run(now(), now());
  }

  private createClient(): AlgoliaClient | null {
    const appId = process.env.ALGOLIA_APPLICATION_ID;
    const apiKey = process.env.ALGOLIA_ADMIN_API_KEY;
    return appId && apiKey ? algoliasearch(appId, apiKey) : null;
  }

  private indexFor(entityType: EntityType): string {
    if (entityType === "todo") return this.todoIndex;
    if (entityType === "memory") return this.memoryIndex;
    return this.messageIndex;
  }

  private indexForType(type: SearchEntityType): string {
    if (type === "todo") return this.todoIndex;
    if (type === "memory") return this.memoryIndex;
    return this.messageIndex;
  }

  projection(entityType: EntityType, entityId: string): SearchRecord | null {
    if (entityType === "todo") {
      const row = getTodo(this.db, entityId);
      if (!row) return null;
      return {
        objectID: row.id,
        userId: row.user_id,
        title: row.title,
        notes: row.notes,
        status: row.status,
        priority: row.priority,
        category_id: row.category_id,
        category_name: row.category_name,
        life_area_id: row.life_area_id,
        life_area_name: row.life_area_name,
        life_area_slug: row.life_area_slug,
        life_area_source: row.life_area_source,
        parent_id: row.parent_id,
        due_at: row.due_at,
        reminder_at: row.reminder_at,
        extra_reminders: JSON.parse(row.extra_reminders_json),
        started_at: row.started_at,
        completed_at: row.completed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }
    if (entityType === "memory") {
      const row = getMemory(this.db, entityId);
      if (!row) return null;
      return {
        objectID: row.id,
        userId: row.user_id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        mood_label: row.mood_label,
        mood_score: row.mood_score,
        category_id: row.category_id,
        category_name: row.category_name,
        life_area_id: row.life_area_id,
        life_area_name: row.life_area_name,
        life_area_slug: row.life_area_slug,
        life_area_source: row.life_area_source,
        occurred_at: row.occurred_at,
        review_worthy: Boolean(row.review_worthy),
        tags: JSON.parse(row.tags_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }
    const row = getChannelMessage(this.db, entityId);
    if (!row || !["user", "assistant"].includes(row.role)) return null;
    // Digest and reflection turns run on scratch threads with an app-composed
    // prompt stored as the user message. A null projection deletes on the next
    // flush and drops out of a rebuild, so a reindex clears any already indexed.
    if (isInternalChannelMessage(row)) return null;
    return {
      objectID: row.id,
      userId: row.user_id,
      threadId: row.thread_id,
      channel: row.channel,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
    };
  }

  /**
   * Collapses claimed jobs into one Algolia write per index and operation.
   * Indexing a job at a time meant a full reindex cost one round-trip per
   * record; `BATCH_SIZE` matches the chunking the v5 helpers use internally.
   */
  private plan(jobs: IndexJobRow[]): IndexBatch[] {
    const groups = new Map<string, IndexBatch>();
    for (const job of jobs) {
      const indexName = this.indexFor(job.entity_type);
      // A missing projection means the row is gone or is not indexable, which
      // needs the same durable outcome as an explicit delete.
      const record = job.operation === "delete"
        ? null
        : this.projection(job.entity_type, job.entity_id);
      const operation = record ? "save" : "delete";
      const key = `${operation} ${indexName}`;
      const group = groups.get(key) ?? { indexName, operation, jobs: [], records: [], objectIDs: [] };
      group.jobs.push(job);
      group.objectIDs.push(job.entity_id);
      if (record) group.records.push(record);
      groups.set(key, group);
    }
    const batches: IndexBatch[] = [];
    for (const group of groups.values()) {
      for (let start = 0; start < group.jobs.length; start += BATCH_SIZE) {
        batches.push({
          indexName: group.indexName,
          operation: group.operation,
          jobs: group.jobs.slice(start, start + BATCH_SIZE),
          records: group.records.slice(start, start + BATCH_SIZE),
          objectIDs: group.objectIDs.slice(start, start + BATCH_SIZE),
        });
      }
    }
    return batches;
  }

  private markDone(jobs: IndexJobRow[]): void {
    const timestamp = now();
    const statement = this.db.prepare(`
      UPDATE index_jobs SET status='done',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=?
    `);
    this.db.transaction(() => {
      for (const job of jobs) statement.run(timestamp, job.id);
    })();
  }

  private markFailed(jobs: IndexJobRow[], error: unknown): void {
    const timestamp = now();
    const message = errorText(error).slice(0, 1000);
    const statement = this.db.prepare(`
      UPDATE index_jobs SET status='failed',attempts=?,last_error=?,available_at=?,updated_at=? WHERE id=?
    `);
    this.db.transaction(() => {
      for (const job of jobs) {
        const attempts = job.attempts + 1;
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10));
        statement.run(
          attempts,
          message,
          new Date(Date.now() + delaySeconds * 1000).toISOString(),
          timestamp,
          job.id,
        );
      }
    })();
  }

  async flush(options: { limit?: number } = {}): Promise<FlushResult> {
    if (!this.client) return { configured: false, processed: 0, succeeded: 0, failed: 0 };
    const limit = Math.max(options.limit ?? 50, 1);
    const jobs = this.db.prepare(`
      SELECT * FROM index_jobs
      WHERE status IN ('pending','failed') AND available_at<=?
      ORDER BY created_at LIMIT ?
    `).all(now(), limit) as IndexJobRow[];
    const claim = this.db.prepare(`
      UPDATE index_jobs SET status='processing',updated_at=?
      WHERE id=? AND status IN ('pending','failed')
    `);
    const timestamp = now();
    const claimed = jobs.filter(job => claim.run(timestamp, job.id).changes > 0);
    let succeeded = 0;
    let failed = 0;
    for (const batch of this.plan(claimed)) {
      try {
        if (batch.operation === "delete") {
          await this.client.deleteObjects({ indexName: batch.indexName, objectIDs: batch.objectIDs });
        } else {
          await this.client.saveObjects({ indexName: batch.indexName, objects: batch.records });
        }
        this.markDone(batch.jobs);
        succeeded += batch.jobs.length;
      } catch (error) {
        this.markFailed(batch.jobs, error);
        failed += batch.jobs.length;
      }
    }
    return { configured: true, processed: succeeded + failed, succeeded, failed };
  }

  flushSoon(): void {
    queueMicrotask(() => {
      void this.flush().catch(() => undefined);
    });
  }

  /** Every indexable entity in SQLite, grouped by the index it belongs to. */
  private indexGroups(): Array<{ indexName: string; entityType: EntityType; ids: string[] }> {
    const ids = (sql: string) => (this.db.prepare(sql).all(USER_ID) as Array<{ id: string }>)
      .map(row => row.id);
    return [
      { indexName: this.todoIndex, entityType: "todo", ids: ids("SELECT id FROM todos WHERE user_id=?") },
      { indexName: this.memoryIndex, entityType: "memory", ids: ids("SELECT id FROM memories WHERE user_id=?") },
      {
        indexName: this.messageIndex,
        entityType: "channel_message",
        ids: ids(`
          SELECT m.id FROM channel_messages m
          JOIN channel_threads t ON t.id=m.thread_id
          WHERE t.user_id=? AND m.role IN ('user','assistant')
            AND COALESCE(json_extract(m.metadata_json,'$.internal'),0)=0
        `),
      },
    ];
  }

  queueReindex(): number {
    const groups = this.indexGroups();
    this.db.transaction(() => {
      for (const group of groups) {
        for (const entityId of group.ids) queueIndexJob(this.db, group.entityType, entityId);
      }
    })();
    return groups.reduce((total, group) => total + group.ids.length, 0);
  }

  /**
   * Rebuilds each index from SQLite. `replaceAllObjects` stages into a
   * temporary index and moves it into place, so a search never observes a
   * half-rebuilt index, and records deleted without a matching outbox job are
   * dropped instead of lingering forever.
   */
  async reindex(): Promise<{ queued: number; processed: number }> {
    if (!this.client) return { queued: 0, processed: 0 };
    const pending = (this.db.prepare(`
      SELECT id FROM index_jobs WHERE status IN ('pending','failed','processing')
    `).all() as Array<{ id: string }>).map(row => row.id);
    let processed = 0;
    for (const group of this.indexGroups()) {
      const objects = group.ids
        .map(entityId => this.projection(group.entityType, entityId))
        .filter((record): record is SearchRecord => record !== null);
      await this.client.replaceAllObjects({
        indexName: group.indexName,
        objects,
        batchSize: BATCH_SIZE,
      });
      processed += objects.length;
    }
    // The rebuild supersedes anything queued before it started. Jobs enqueued
    // during the rebuild are deliberately left alone so their writes still land.
    const timestamp = now();
    const statement = this.db.prepare(`
      UPDATE index_jobs SET status='done',last_error=NULL,updated_at=? WHERE id=?
    `);
    this.db.transaction(() => {
      for (const jobId of pending) statement.run(timestamp, jobId);
    })();
    return { queued: processed, processed };
  }

  /** NeuralSearch is a paid add-on, so keyword search is the default. */
  neuralSearchEnabled(): boolean {
    return getSearchPreferences(this.db).neuralSearchEnabled;
  }

  /**
   * Index settings live in `agent-studio/indices/*.json` rather than here, so
   * the files that get pasted into the dashboard are the same ones this applies.
   * Previously they were separate and had already drifted apart.
   *
   * `mode` is the one setting the files do not own: it is driven by the
   * NeuralSearch toggle so an application without the entitlement still gets a
   * working keyword index.
   */
  async indexSettings(): Promise<Array<{ indexName: string; indexSettings: Record<string, unknown> }>> {
    const directory = this.settingsDirectory;
    const mode = this.neuralSearchEnabled() ? "neuralSearch" : "keywordSearch";
    const read = async (file: string) => ({
      ...JSON.parse(await readFile(resolve(directory, file), "utf8")) as Record<string, unknown>,
      mode,
    });
    const [todos, memories, messages] = await Promise.all([
      read("todos.settings.json"),
      read("memories.settings.json"),
      read("messages.settings.json"),
    ]);
    return [
      { indexName: this.todoIndex, indexSettings: todos },
      { indexName: this.memoryIndex, indexSettings: memories },
      { indexName: this.messageIndex, indexSettings: messages },
    ];
  }

  /**
   * Applies one index's settings, falling back to keyword mode if NeuralSearch
   * is not entitled on the plan. Returns the warning so the caller can report
   * degraded relevance rather than failing the whole setup.
   */
  private async applySettings(
    entry: { indexName: string; indexSettings: Record<string, unknown> },
  ): Promise<{ taskID: number; warning?: string }> {
    const client = this.client!;
    try {
      const task = await client.setSettings(entry);
      return { taskID: task.taskID };
    } catch (error) {
      if (entry.indexSettings.mode !== "neuralSearch") throw error;
      const task = await client.setSettings({
        indexName: entry.indexName,
        indexSettings: { ...entry.indexSettings, mode: "keywordSearch" },
      });
      return { taskID: task.taskID, warning: errorText(error).slice(0, 300) };
    }
  }

  async setup(): Promise<{ configured: boolean; details?: Record<string, unknown> }> {
    if (!this.client) return { configured: false, details: { reason: "Missing server-side Algolia credentials" } };
    const requested = this.neuralSearchEnabled();
    const configured = await this.indexSettings();
    const results = await Promise.all(configured.map(entry => this.applySettings(entry)));
    await Promise.all(results.map((result, index) =>
      this.client!.waitForTask({ indexName: configured[index].indexName, taskID: result.taskID })
    ));
    for (const entry of configured) this.userFilterConfigured.set(entry.indexName, true);
    const warning = results.find(result => result.warning)?.warning;
    // `mode: neuralSearch` only takes effect once NeuralSearch is enabled for
    // the application in the dashboard; the index setting alone cannot do it.
    if (!requested) return { configured: true, details: { search: "keyword" } };
    return warning
      ? { configured: true, details: { search: "keyword", neuralSearch: "unavailable_for_plan", warning } }
      : { configured: true, details: { search: "neural" } };
  }

  async health(): Promise<{
    ok: boolean;
    configured: boolean;
    error?: string;
    todoRecords?: number;
    memoryRecords?: number;
    messageRecords?: number;
  }> {
    if (!this.client) return { ok: true, configured: false };
    try {
      const [todos, memories, messages] = await Promise.all([
        this.client.searchSingleIndex({ indexName: this.todoIndex, searchParams: { query: "", hitsPerPage: 0 } }),
        this.client.searchSingleIndex({ indexName: this.memoryIndex, searchParams: { query: "", hitsPerPage: 0 } }),
        this.client.searchSingleIndex({ indexName: this.messageIndex, searchParams: { query: "", hitsPerPage: 0 } }),
      ]);
      return {
        ok: true,
        configured: true,
        todoRecords: "nbHits" in todos ? todos.nbHits : undefined,
        memoryRecords: "nbHits" in memories ? memories.nbHits : undefined,
        messageRecords: "nbHits" in messages ? messages.nbHits : undefined,
      };
    } catch (error) {
      return { ok: false, configured: true, error: errorText(error) };
    }
  }

  /** Restricts every query to the demo user, whatever index it runs against. */
  private get userFilter(): string {
    return `userId:"${USER_ID.replaceAll('"', '\\"')}"`;
  }

  /**
   * An index whose settings were never applied has no `userId` facet, so the
   * filter would be silently dropped and results would span every user. Fail
   * loudly instead, and remember the answer so it costs one call per index.
   */
  private async assertUserFilter(indexName: string, label: string): Promise<void> {
    if (this.userFilterConfigured.get(indexName)) return;
    const settings = await this.client!.getSettings({ indexName });
    const facets = Array.isArray(settings.attributesForFaceting) ? settings.attributesForFaceting : [];
    const configured = facets.some(attribute =>
      attribute === "userId" || attribute === "filterOnly(userId)" || attribute === "searchable(userId)"
    );
    if (!configured) {
      throw new Error(`${label} index is missing filterOnly(userId); configure Algolia before semantic search`);
    }
    this.userFilterConfigured.set(indexName, true);
  }

  private async searchIndex(
    indexName: string,
    label: string,
    searchParams: { query: string; limit: number; filters?: string[]; attributesToRetrieve?: string[] },
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.client) throw new Error("Algolia is not configured");
    await this.assertUserFilter(indexName, label);
    const result = await this.client.searchSingleIndex({
      indexName,
      searchParams: {
        query: searchParams.query,
        filters: [this.userFilter, ...(searchParams.filters ?? [])].join(" AND "),
        hitsPerPage: Math.min(Math.max(searchParams.limit, 1), 50),
        attributesToRetrieve: searchParams.attributesToRetrieve,
      },
    });
    return result.hits as Array<Record<string, unknown>>;
  }

  async searchMessages(query: string, limit = 20): Promise<Array<{
    objectID: string;
    threadId: string;
    channel: "web" | "sms";
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>> {
    const hits = await this.searchIndex(this.messageIndex, "Conversation", {
      query,
      limit,
      attributesToRetrieve: RETRIEVED_ATTRIBUTES.message,
    });
    return hits.map(hit => ({
      objectID: String(hit.objectID),
      threadId: String(hit.threadId),
      channel: hit.channel === "sms" ? "sms" : "web",
      role: hit.role === "assistant" ? "assistant" : "user",
      content: String(hit.content || ""),
      created_at: String(hit.created_at || ""),
    }));
  }

  /**
   * Ranked memory IDs rather than records: SQLite stays authoritative for the
   * response body, so the caller hydrates these and keeps this order.
   */
  async searchMemories(
    query: string,
    options: { limit?: number } & MemorySearchFilters = {},
  ): Promise<string[]> {
    const facets: string[] = [];
    // Every one of these is an attributeForFaceting on the memory index.
    if (options.kind) facets.push(`kind:"${escapeFilterValue(options.kind)}"`);
    if (options.category_id) facets.push(`category_id:"${escapeFilterValue(options.category_id)}"`);
    if (options.life_area_id) facets.push(`life_area_id:"${escapeFilterValue(options.life_area_id)}"`);
    if (options.mood_label) facets.push(`mood_label:"${escapeFilterValue(options.mood_label)}"`);
    if (options.review_worthy !== undefined) facets.push(`review_worthy:${options.review_worthy}`);
    const hits = await this.searchIndex(this.memoryIndex, "Memory", {
      query,
      limit: options.limit ?? 50,
      filters: facets,
      attributesToRetrieve: ["objectID"],
    });
    return hits.map(hit => String(hit.objectID));
  }

  /**
   * Federated search for the command palette. One multi-index request keeps a
   * keystroke to a single round trip no matter how many surfaces it covers.
   */
  async searchAll(query: string, options: { types?: SearchEntityType[]; limit?: number } = {}): Promise<{
    counts: Record<SearchEntityType, number>;
    hits: Record<SearchEntityType, Array<Record<string, unknown>>>;
  }> {
    if (!this.client) throw new Error("Algolia is not configured");
    const types = options.types?.length ? options.types : SEARCH_ENTITY_TYPES;
    const hitsPerPage = Math.min(Math.max(options.limit ?? 8, 1), 50);
    const labels: Record<SearchEntityType, string> = {
      todo: "Todo",
      memory: "Memory",
      message: "Conversation",
    };
    await Promise.all(types.map(type => this.assertUserFilter(this.indexForType(type), labels[type])));
    const { results } = await this.client.search({
      requests: types.map(type => ({
        indexName: this.indexForType(type),
        query,
        filters: this.userFilter,
        hitsPerPage,
        attributesToRetrieve: RETRIEVED_ATTRIBUTES[type],
      })),
    });
    const counts = { todo: 0, memory: 0, message: 0 };
    const hits: Record<SearchEntityType, Array<Record<string, unknown>>> = {
      todo: [], memory: [], message: [],
    };
    types.forEach((type, index) => {
      const result = results[index] as { hits?: Array<Record<string, unknown>>; nbHits?: number } | undefined;
      hits[type] = result?.hits ?? [];
      counts[type] = result?.nbHits ?? hits[type].length;
    });
    return { counts, hits };
  }
}
