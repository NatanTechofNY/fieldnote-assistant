import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { algoliasearch } from "algoliasearch";
import {
  getChannelMessage, getMemory, getStoreProduct, getTodo, now, queueIndexJob, USER_ID,
} from "./db.ts";
import { getNotificationPreferences, getSearchPreferences } from "./integrations.ts";
import { localParts } from "./local-time.ts";
import { parseRecurrence, recurrenceJson } from "./recurrence.ts";
import { groupIdOfAddress } from "./sendblue-service.ts";
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

/** The name a group message was stored with, when the speaker had one. */
function speakerNameOf(metadataJson: string): string | null {
  try {
    const name = (JSON.parse(metadataJson) as { speakerName?: unknown }).speakerName;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * The day a memory belongs to, written the two ways a person asks for it.
 *
 * Timestamps are retrieved with a hit but never matched, so "what was my mood
 * on July 31" had no query that could reach a record whose text never names the
 * date — the agent searched "July 31" and "2026-07-31", got nothing, and said
 * nothing was stored. Putting the day into the record as text makes the date a
 * search term like any other, and soft: a query that misses on the day still
 * ranks on the rest of its words instead of hiding the record the way a facet
 * filter would. The day is local to the user, since that is the day they lived.
 */
function memoryDay(anchor: string, timezone: string): { occurred_on: string; occurred_on_text: string } | null {
  const date = new Date(anchor);
  if (Number.isNaN(date.getTime())) return null;
  return {
    occurred_on: localParts(date, timezone).date,
    occurred_on_text: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "long", month: "long", day: "numeric", year: "numeric",
    }).format(date),
  };
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
    "tags", "category_name", "life_area_name", "occurred_at", "occurred_on", "updated_at",
  ],
  message: ["objectID", "threadId", "channel", "role", "content", "created_at", "speaker_name", "group_name", "group_id"],
};

/**
 * NeuralSearch activation is refused with `412 SemanticSearch: no events` unless
 * the request also names a vector model and the attributes to vectorize. Naming
 * them is what removes the need for click and conversion events: the events gate
 * guards Algolia's *automatic* attribute selection, not NeuralSearch itself.
 */
const VECTOR_MODEL_ID = "external://algolia-large-multilang-generic-v2410";

/**
 * `neuralExpression` weights the attributes that get vectorized, so it is
 * derived from the same `searchableAttributes` the index already ranks on
 * instead of being a second list to keep in sync. Modifiers and comma-grouped
 * equivalents are unwrapped: `unordered(title)` weights `title`.
 */
function neuralExpressionFor(searchableAttributes: unknown): Record<string, number> {
  const attributes = Array.isArray(searchableAttributes) ? searchableAttributes : [];
  const expression: Record<string, number> = {};
  for (const entry of attributes) {
    if (typeof entry !== "string") continue;
    for (const part of entry.split(",")) {
      const name = part.trim().replace(/^\w+\((.*)\)$/, "$1").trim();
      if (name) expression[name] = 1;
    }
  }
  return expression;
}

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
  productIndex?: string;
  settingsDirectory?: string;
}

export interface ProductSearchFilters {
  category?: string | null;
  maxPriceCents?: number | null;
}

export interface FlushResult {
  configured: boolean;
  processed: number;
  succeeded: number;
  failed: number;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Facet values are quoted in the filter string, so quotes must be escaped. */
export const escapeFilterValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/**
 * The personal-data index names the environment resolves to. The sync service
 * takes the same defaults through its options; this is for callers that need
 * the names without a client, such as the per-request search filters a group
 * turn sends with its completion.
 */
export function configuredIndexNames(): { todo: string; memory: string; message: string } {
  return {
    todo: process.env.ALGOLIA_TODO_INDEX || "devcon_assistant_todos",
    memory: process.env.ALGOLIA_MEMORY_INDEX || "devcon_assistant_memories",
    message: process.env.ALGOLIA_MESSAGE_INDEX || "devcon_assistant_messages",
  };
}

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
  readonly productIndex: string;
  readonly client: AlgoliaClient | null;
  readonly settingsDirectory: string;
  /** Per-index memo of the `filterOnly(userId)` check, keyed by index name. */
  private userFilterConfigured = new Map<string, boolean>();

  constructor(db: Db, options: AlgoliaOptions = {}) {
    this.db = db;
    const defaults = configuredIndexNames();
    this.todoIndex = options.todoIndex || defaults.todo;
    this.memoryIndex = options.memoryIndex || defaults.memory;
    this.messageIndex = options.messageIndex || defaults.message;
    this.productIndex = options.productIndex || process.env.ALGOLIA_PRODUCT_INDEX || "devcon_assistant_products";
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
    if (entityType === "product") return this.productIndex;
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
      const recurrenceRule = parseRecurrence(row.recurrence_json);
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
        recurrence: recurrenceRule ? recurrenceJson(recurrenceRule) : null,
        is_recurring: Boolean(recurrenceRule),
        last_completed_at: row.last_completed_at ?? null,
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
        // A fact has no occurred_at; the day it was saved is the day it is about.
        ...memoryDay(row.occurred_at || row.created_at, getNotificationPreferences(this.db).timezone),
        review_worthy: Boolean(row.review_worthy),
        tags: JSON.parse(row.tags_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }
    if (entityType === "product") {
      const row = getStoreProduct(this.db, entityId);
      if (!row) return null;
      // The catalog is not personal data, but every index carries the demo
      // user's filter so the same guarded search path serves all of them.
      return {
        objectID: row.id,
        userId: USER_ID,
        sku: row.sku,
        store: row.store,
        name: row.name,
        brand: row.brand,
        description: row.description,
        category: row.category,
        symptoms: JSON.parse(row.symptoms_json),
        size: row.size,
        price_cents: row.price_cents,
        image_url: row.image_url,
        product_url: row.product_url,
        popularity: row.popularity,
        updated_at: row.updated_at,
      };
    }
    const row = getChannelMessage(this.db, entityId);
    if (!row || !["user", "assistant"].includes(row.role)) return null;
    // Digest and reflection turns run on scratch threads with an app-composed
    // prompt stored as the user message. A null projection deletes on the next
    // flush and drops out of a rebuild, so a reindex clears any already indexed.
    if (isInternalChannelMessage(row)) return null;
    // A group message says which group and who spoke, by name only, so "what
    // did Cementa ask for" is a search. Phone numbers stay out of the index,
    // and a 1:1 or web record keeps exactly the shape it always had.
    const groupId = row.address ? groupIdOfAddress(row.address) : undefined;
    const speakerName = row.role === "user" ? speakerNameOf(row.metadata_json) : null;
    return {
      objectID: row.id,
      userId: row.user_id,
      threadId: row.thread_id,
      channel: row.channel,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
      ...(groupId ? {
        group_id: groupId,
        ...(row.group_name ? { group_name: row.group_name } : {}),
        ...(speakerName ? { speaker_name: speakerName } : {}),
      } : {}),
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
      {
        indexName: this.productIndex,
        entityType: "product",
        ids: (this.db.prepare("SELECT id FROM store_products").all() as Array<{ id: string }>).map(row => row.id),
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
   * `mode` is absent by design. It is owned by the semantic settings endpoint,
   * which flips it as a side effect of activation; writing it here is refused
   * even when the index is already in the mode being written.
   */
  async indexSettings(): Promise<Array<{ indexName: string; indexSettings: Record<string, unknown> }>> {
    const directory = this.settingsDirectory;
    const read = async (file: string) => (
      JSON.parse(await readFile(resolve(directory, file), "utf8")) as Record<string, unknown>
    );
    const [todos, memories, messages, products] = await Promise.all([
      read("todos.settings.json"),
      read("memories.settings.json"),
      read("messages.settings.json"),
      read("products.settings.json"),
    ]);
    return [
      { indexName: this.todoIndex, indexSettings: todos },
      { indexName: this.memoryIndex, indexSettings: memories },
      { indexName: this.messageIndex, indexSettings: messages },
      { indexName: this.productIndex, indexSettings: products },
    ];
  }

  /**
   * Switches one index between semantic and keyword retrieval. The API clients
   * do not model this endpoint, so it goes through `customPut`; activation is
   * asynchronous, and the read-back can lag the write by several seconds.
   *
   * `path` must not start with a slash. A leading one fails as "Unreachable
   * hosts - your application id may be incorrect", which reads as a credentials
   * problem rather than the string formatting mistake it is.
   */
  private async applySemanticSearch(
    entry: { indexName: string; indexSettings: Record<string, unknown> },
  ): Promise<void> {
    const path = `1/indexes/${encodeURIComponent(entry.indexName)}/semanticSearch/settings`;
    const wanted = this.neuralSearchEnabled();
    // Neural operations are capped at 10 per hour per application, which a few
    // toggle flips would exhaust, so an index already in the requested state is
    // left alone rather than rewritten. Activation needs a vector model to have
    // been accepted, not just the mode to read back.
    const current = await this.client!.customGet({ path }) as Record<string, unknown>;
    const active = current.neuralSearchMode === "active" && Boolean(current.vectorModelId);
    if (active === wanted) return;
    await this.client!.customPut({
      path,
      body: wanted
        ? {
          neuralSearchMode: "active",
          vectorModelId: VECTOR_MODEL_ID,
          neuralExpression: neuralExpressionFor(entry.indexSettings.searchableAttributes),
        }
        : { neuralSearchMode: "inactive" },
    });
  }

  async setup(): Promise<{ configured: boolean; details?: Record<string, unknown> }> {
    if (!this.client) return { configured: false, details: { reason: "Missing server-side Algolia credentials" } };
    const requested = this.neuralSearchEnabled();
    const configured = await this.indexSettings();
    // Deliberately not waiting for the settings tasks to publish. On an index
    // with NeuralSearch active the task stays `notPublished` while the index
    // re-vectorizes, measured at 269 seconds on six records, so waiting turned
    // a routine button into a four-minute spinner. Worse, `waitForTask` gives
    // up after 100 polls and reports failure for settings that were accepted
    // immediately. Algolia applies them in order regardless.
    await Promise.all(configured.map(entry => this.client!.setSettings(entry)));
    for (const entry of configured) this.userFilterConfigured.set(entry.indexName, true);
    // Retrieval mode is a separate endpoint from index settings, and a refusal
    // there has to leave a working keyword index rather than fail the setup.
    let warning: string | undefined;
    for (const entry of configured) {
      try {
        await this.applySemanticSearch(entry);
      } catch (error) {
        warning ??= errorText(error).slice(0, 300);
      }
    }
    if (!requested) return { configured: true, details: { search: "keyword" } };
    return warning
      ? { configured: true, details: { search: "keyword", neuralSearch: "unavailable", warning } }
      : { configured: true, details: { search: "neural" } };
  }

  async health(): Promise<{
    ok: boolean;
    configured: boolean;
    error?: string;
    todoRecords?: number;
    memoryRecords?: number;
    messageRecords?: number;
    productRecords?: number;
  }> {
    if (!this.client) return { ok: true, configured: false };
    try {
      const [todos, memories, messages, products] = await Promise.all([
        this.client.searchSingleIndex({ indexName: this.todoIndex, searchParams: { query: "", hitsPerPage: 0 } }),
        this.client.searchSingleIndex({ indexName: this.memoryIndex, searchParams: { query: "", hitsPerPage: 0 } }),
        this.client.searchSingleIndex({ indexName: this.messageIndex, searchParams: { query: "", hitsPerPage: 0 } }),
        this.client.searchSingleIndex({ indexName: this.productIndex, searchParams: { query: "", hitsPerPage: 0 } }),
      ]);
      return {
        ok: true,
        configured: true,
        todoRecords: "nbHits" in todos ? todos.nbHits : undefined,
        memoryRecords: "nbHits" in memories ? memories.nbHits : undefined,
        messageRecords: "nbHits" in messages ? messages.nbHits : undefined,
        productRecords: "nbHits" in products ? products.nbHits : undefined,
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
    speaker_name?: string;
    group_name?: string;
    group_id?: string;
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
      ...(typeof hit.speaker_name === "string" ? { speaker_name: hit.speaker_name } : {}),
      ...(typeof hit.group_name === "string" ? { group_name: hit.group_name } : {}),
      ...(typeof hit.group_id === "string" ? { group_id: hit.group_id } : {}),
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
   * Ranked catalog IDs, hydrated by the caller from `store_products`. A price
   * cap is a numeric filter rather than a facet, so it is spelled inline.
   */
  async searchProducts(
    query: string,
    options: { limit?: number } & ProductSearchFilters = {},
  ): Promise<string[]> {
    const filters: string[] = [];
    if (options.category) filters.push(`category:"${escapeFilterValue(options.category)}"`);
    if (options.maxPriceCents != null) filters.push(`price_cents <= ${Math.floor(options.maxPriceCents)}`);
    const hits = await this.searchIndex(this.productIndex, "Product", {
      query,
      limit: options.limit ?? 5,
      filters,
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
