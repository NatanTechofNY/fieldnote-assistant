import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChannelMessageRow, Db, EntityType, IndexOperation, MemoryRow, ReminderRow, TodoRow } from "./types.ts";
import { USER_ID } from "./types.ts";

export { USER_ID };
export const now = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

const canonicalSchema = `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('todo','memory')),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, kind, name)
);
CREATE TABLE IF NOT EXISTS life_areas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL,
  life_area_source TEXT CHECK(life_area_source IS NULL OR life_area_source IN ('agent','user')),
  parent_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
  due_at TEXT,
  reminder_at TEXT,
  extra_reminders_json TEXT NOT NULL DEFAULT '[]',
  priority TEXT CHECK(priority IS NULL OR priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','in_progress','blocked','done','cancelled')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_user_status ON todos(user_id, status);
CREATE INDEX IF NOT EXISTS todos_due ON todos(user_id, due_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','note','journal')),
  mood_label TEXT,
  mood_score INTEGER CHECK(mood_score IS NULL OR mood_score BETWEEN 1 AND 5),
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL,
  life_area_source TEXT CHECK(life_area_source IS NULL OR life_area_source IN ('agent','user')),
  occurred_at TEXT,
  review_worthy INTEGER NOT NULL DEFAULT 0 CHECK(review_worthy IN (0,1)),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_user_kind ON memories(user_id, kind);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_current
  ON conversations(user_id) WHERE is_current=1;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_args_json TEXT,
  tool_result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('due','pre','escalation')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
  delivered_at TEXT,
  claimed_at TEXT,
  available_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(todo_id, scheduled_for, kind)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(user_id, status, scheduled_for);
CREATE TABLE IF NOT EXISTS index_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('todo','memory','channel_message')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_jobs_ready ON index_jobs(status, available_at);
CREATE TABLE IF NOT EXISTS integration_settings (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  encrypted_secret TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK(status IN ('disconnected','connected','error')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, provider)
);
CREATE TABLE IF NOT EXISTS search_preferences (
  user_id TEXT PRIMARY KEY,
  neural_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK(neural_search_enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_preferences (
  user_id TEXT PRIMARY KEY,
  auto_complete_parent INTEGER NOT NULL DEFAULT 0 CHECK(auto_complete_parent IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY,
  sms_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sms_enabled IN (0,1)),
  sms_provider TEXT NOT NULL DEFAULT 'twilio' CHECK(sms_provider IN ('twilio','sendblue')),
  recipient_phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  daily_digest_enabled INTEGER NOT NULL DEFAULT 0 CHECK(daily_digest_enabled IN (0,1)),
  daily_digest_time TEXT NOT NULL DEFAULT '09:00',
  digest_include_todos INTEGER NOT NULL DEFAULT 0 CHECK(digest_include_todos IN (0,1)),
  digest_include_overdue INTEGER NOT NULL DEFAULT 0 CHECK(digest_include_overdue IN (0,1)),
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  opted_out_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web','sms')),
  address TEXT NOT NULL,
  agent_conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, channel, address)
);
CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES channel_threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK(status IN ('received','queued','sent','delivered','failed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_message_id)
);
CREATE INDEX IF NOT EXISTS channel_messages_thread ON channel_messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS reflection_exclusions (
  user_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('memory','todo')),
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope_key,entity_type,entity_id)
);
CREATE INDEX IF NOT EXISTS reflection_exclusions_scope ON reflection_exclusions(user_id,scope_key);
CREATE TABLE IF NOT EXISTS reflection_selections (
  user_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('memory','todo')),
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope_key,entity_type,entity_id)
);
CREATE INDEX IF NOT EXISTS reflection_selections_scope ON reflection_selections(user_id,scope_key);
CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS external_events_ready ON external_events(status, available_at);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS scheduled_dispatches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('daily_digest','reminder','digest_brief')),
  idempotency_key TEXT NOT NULL UNIQUE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digest_briefs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  send_time TEXT NOT NULL DEFAULT '08:00',
  resources_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS digest_briefs_due ON digest_briefs(user_id, enabled, send_time);
`;

function columns(db: Db, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

/**
 * A `CHECK` constraint cannot be altered in place, so widening the dispatch
 * kinds means copying the table. `canonicalSchema` already carries the current
 * list, so a database created today does not need the copy at all: ask the
 * stored SQL what it admits before rewriting it, the same way migration 7 asks
 * about `index_jobs`.
 */
function dispatchKindAllows(db: Db, kind: string): boolean {
  const sql = String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_dispatches'",
  ).get() as { sql?: string } | undefined)?.sql || "");
  return sql.includes(`'${kind}'`);
}

function migrateLegacyV1(db: Db): void {
  if (!columns(db, "todos").has("description")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      ALTER TABLE categories RENAME TO categories_v1;
      ALTER TABLE todos RENAME TO todos_v1;
      ALTER TABLE memories RENAME TO memories_v1;
      ALTER TABLE reminders RENAME TO reminders_v1;
      ALTER TABLE messages RENAME TO messages_v1;
      DROP INDEX IF EXISTS todos_user_status;
      DROP INDEX IF EXISTS todos_due;
      DROP INDEX IF EXISTS memories_user_kind;
      DROP INDEX IF EXISTS messages_conversation;
      DROP INDEX IF EXISTS reminders_poll;
    `);
    db.exec(canonicalSchema);
    db.exec(`
      INSERT INTO categories(id,user_id,kind,name,color,icon,created_at,updated_at)
        SELECT id,user_id,
          CASE WHEN lower(name) IN ('memory','memories','journal') THEN 'memory' ELSE 'todo' END,
          name,COALESCE(color,'#64748b'),NULL,created_at,updated_at FROM categories_v1;
      INSERT INTO todos(
        id,user_id,title,notes,category_id,parent_id,due_at,reminder_at,extra_reminders_json,
        priority,status,started_at,completed_at,created_at,updated_at
      )
        SELECT id,user_id,title,NULLIF(description,''),category_id,parent_id,due_at,reminder_at,'[]',
          CASE priority WHEN 1 THEN 'low' WHEN 2 THEN 'normal' WHEN 3 THEN 'high'
            WHEN 4 THEN 'urgent' ELSE NULL END,
          status,CASE WHEN status='in_progress' THEN updated_at ELSE NULL END,
          completed_at,created_at,updated_at FROM todos_v1;
      INSERT INTO memories(
        id,user_id,title,content,kind,mood_label,mood_score,category_id,tags_json,created_at,updated_at
      )
        SELECT id,user_id,NULLIF(title,''),content,kind,mood,NULL,category_id,'[]',created_at,updated_at
        FROM memories_v1;
      INSERT INTO reminders(
        id,user_id,todo_id,scheduled_for,kind,status,delivered_at,created_at,updated_at
      )
        SELECT id,user_id,todo_id,remind_at,'pre',
          CASE WHEN dismissed_at IS NOT NULL THEN 'cancelled'
            WHEN delivered_at IS NOT NULL THEN 'sent' ELSE 'pending' END,
          delivered_at,created_at,updated_at FROM reminders_v1 WHERE todo_id IS NOT NULL;
      INSERT INTO messages(
        id,conversation_id,role,content,tool_name,tool_args_json,tool_result_json,created_at
      )
        SELECT id,conversation_id,role,content,NULL,NULL,metadata_json,created_at FROM messages_v1;
      DROP TABLE reminders_v1;
      DROP TABLE memories_v1;
      DROP TABLE todos_v1;
      DROP TABLE categories_v1;
      DROP TABLE messages_v1;
    `);
  })();
  db.pragma("foreign_keys = ON");
}

function migrateConversations(db: Db): void {
  const conversationColumns = columns(db, "conversations");
  if (!conversationColumns.has("is_current")) {
    db.exec("ALTER TABLE conversations ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1))");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversations_current ON conversations(user_id) WHERE is_current=1");
  db.prepare(`
    UPDATE conversations SET is_current=1 WHERE id=(
      SELECT id FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 1
    ) AND NOT EXISTS(SELECT 1 FROM conversations WHERE user_id=? AND is_current=1)
  `).run(USER_ID, USER_ID);
}

function migrateMessaging(db: Db): void {
  const reminderColumns = columns(db, "reminders");
  const additions = [
    ["claimed_at", "TEXT"],
    ["available_at", "TEXT"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["provider_message_id", "TEXT"],
    ["last_error", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!reminderColumns.has(name)) db.exec(`ALTER TABLE reminders ADD COLUMN ${name} ${definition}`);
  }
  db.prepare("UPDATE reminders SET available_at=scheduled_for WHERE available_at IS NULL").run();
  if (!columns(db, "scheduled_dispatches").has("available_at")) {
    db.exec("ALTER TABLE scheduled_dispatches ADD COLUMN available_at TEXT");
  }
  const preferenceColumns = columns(db, "notification_preferences");
  if (!preferenceColumns.has("digest_include_todos")) {
    db.exec(`
      ALTER TABLE notification_preferences
      ADD COLUMN digest_include_todos INTEGER NOT NULL DEFAULT 0 CHECK(digest_include_todos IN (0,1))
    `);
  }
  if (!preferenceColumns.has("digest_include_overdue")) {
    db.exec(`
      ALTER TABLE notification_preferences
      ADD COLUMN digest_include_overdue INTEGER NOT NULL DEFAULT 0
      CHECK(digest_include_overdue IN (0,1))
    `);
  }
  // Twilio was the only provider before Sendblue, so an existing database keeps
  // sending through it until the toggle is moved.
  if (!preferenceColumns.has("sms_provider")) {
    db.exec(`
      ALTER TABLE notification_preferences
      ADD COLUMN sms_provider TEXT NOT NULL DEFAULT 'twilio' CHECK(sms_provider IN ('twilio','sendblue'))
    `);
  }
  const timestamp = now();
  db.prepare(`
    INSERT OR IGNORE INTO notification_preferences(
      user_id,sms_enabled,timezone,daily_digest_enabled,daily_digest_time,created_at,updated_at
    ) VALUES(?,0,'UTC',0,'09:00',?,?)
  `).run(USER_ID, timestamp, timestamp);
  // Closing a parent is a judgement call, so the cascade stays off until asked for.
  db.prepare(`
    INSERT OR IGNORE INTO task_preferences(user_id,auto_complete_parent,created_at,updated_at)
    VALUES(?,0,?,?)
  `).run(USER_ID, timestamp, timestamp);
}

export function openDatabase(filename = process.env.DATABASE_PATH || resolve("data/assistant.db")): Db {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const hasTodos = Boolean(
    db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='todos'").get(),
  );
  if (hasTodos) migrateLegacyV1(db);
  db.exec(canonicalSchema);
  const lifeAreaTimestamp = now();
  const insertLifeArea = db.prepare(`
    INSERT OR IGNORE INTO life_areas(id,user_id,slug,name,color,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
  `);
  insertLifeArea.run("area_work", USER_ID, "work", "Work", "#2c5f8a", lifeAreaTimestamp, lifeAreaTimestamp);
  insertLifeArea.run("area_personal", USER_ID, "personal", "Personal", "#b27a22", lifeAreaTimestamp, lifeAreaTimestamp);
  insertLifeArea.run("area_side_project", USER_ID, "side-project", "Side Project", "#7a5c91", lifeAreaTimestamp, lifeAreaTimestamp);
  migrateConversations(db);
  migrateMessaging(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,?)").run(now());
  const reminderDedupeApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=4",
  ).get();
  if (!reminderDedupeApplied) {
    db.transaction(() => {
      db.prepare(`
        DELETE FROM reminders
        WHERE status IN ('pending','failed')
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM reminders
            WHERE status IN ('pending','failed')
            GROUP BY todo_id,scheduled_for
          )
      `).run();
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)").run(now());
    })();
  }
  const reminderInstantDedupeApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=5",
  ).get();
  if (!reminderInstantDedupeApplied) {
    db.transaction(() => {
      const activeReminders = db.prepare(`
        SELECT rowid,todo_id,scheduled_for FROM reminders
        WHERE status IN ('pending','failed')
        ORDER BY todo_id,
          CASE kind WHEN 'due' THEN 0 WHEN 'pre' THEN 1 ELSE 2 END,
          rowid
      `).all() as Array<{ rowid: number; todo_id: string; scheduled_for: string }>;
      const seen = new Set<string>();
      const remove = db.prepare("DELETE FROM reminders WHERE rowid=?");
      for (const reminder of activeReminders) {
        const timestamp = new Date(reminder.scheduled_for).getTime();
        const instant = Number.isNaN(timestamp) ? reminder.scheduled_for : String(timestamp);
        const key = `${reminder.todo_id}:${instant}`;
        if (seen.has(key)) remove.run(reminder.rowid);
        else seen.add(key);
      }
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)").run(now());
    })();
  }
  const lifeAreasApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=6",
  ).get();
  if (!lifeAreasApplied) {
    db.transaction(() => {
      const todoColumns = columns(db, "todos");
      const memoryColumns = columns(db, "memories");
      if (!todoColumns.has("life_area_id")) db.exec("ALTER TABLE todos ADD COLUMN life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL");
      if (!todoColumns.has("life_area_source")) db.exec("ALTER TABLE todos ADD COLUMN life_area_source TEXT CHECK(life_area_source IS NULL OR life_area_source IN ('agent','user'))");
      if (!memoryColumns.has("life_area_id")) db.exec("ALTER TABLE memories ADD COLUMN life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL");
      if (!memoryColumns.has("life_area_source")) db.exec("ALTER TABLE memories ADD COLUMN life_area_source TEXT CHECK(life_area_source IS NULL OR life_area_source IN ('agent','user'))");
      if (!memoryColumns.has("occurred_at")) db.exec("ALTER TABLE memories ADD COLUMN occurred_at TEXT");
      if (!memoryColumns.has("review_worthy")) db.exec("ALTER TABLE memories ADD COLUMN review_worthy INTEGER NOT NULL DEFAULT 0 CHECK(review_worthy IN (0,1))");
      db.prepare(`
        UPDATE todos SET
          life_area_id=CASE lower((SELECT name FROM categories WHERE id=todos.category_id))
            WHEN 'work' THEN 'area_work' WHEN 'personal' THEN 'area_personal' END,
          life_area_source='user'
        WHERE life_area_id IS NULL
          AND lower((SELECT name FROM categories WHERE id=todos.category_id)) IN ('work','personal')
      `).run();
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(6,?)").run(now());
    })();
  }
  const messageIndexingApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=7",
  ).get();
  if (!messageIndexingApplied) {
    const indexJobsSql = String((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='index_jobs'",
    ).get() as { sql?: string } | undefined)?.sql || "");
    if (!indexJobsSql.includes("'channel_message'")) {
      db.transaction(() => {
        db.exec(`
          DROP INDEX IF EXISTS index_jobs_ready;
          ALTER TABLE index_jobs RENAME TO index_jobs_v6;
          CREATE TABLE index_jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('todo','memory','channel_message')),
            entity_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','done')),
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at TEXT NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO index_jobs SELECT * FROM index_jobs_v6;
          DROP TABLE index_jobs_v6;
          CREATE INDEX index_jobs_ready ON index_jobs(status, available_at);
        `);
      })();
    }
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(7,?)").run(now());
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(8,?)").run(now());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(9,?)").run(now());
  const reminderHistoryApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=10",
  ).get();
  if (!reminderHistoryApplied) {
    db.transaction(() => {
      const reminders = db.prepare(`
        SELECT r.id,r.todo_id,r.provider_message_id,r.delivered_at,r.updated_at,t.title,p.recipient_phone
        FROM reminders r JOIN todos t ON t.id=r.todo_id
        JOIN notification_preferences p ON p.user_id=t.user_id
        WHERE r.status='sent' AND r.provider_message_id IS NOT NULL
          AND p.recipient_phone IS NOT NULL
      `).all() as Array<{
        id: string;
        todo_id: string;
        provider_message_id: string;
        delivered_at: string | null;
        updated_at: string;
        title: string;
        recipient_phone: string;
      }>;
      for (const reminder of reminders) {
        if (db.prepare("SELECT 1 found FROM channel_messages WHERE provider_message_id=?")
          .get(reminder.provider_message_id)) continue;
        let thread = db.prepare(`
          SELECT id FROM channel_threads WHERE user_id=? AND channel='sms' AND address=?
        `).get(USER_ID, reminder.recipient_phone) as { id: string } | undefined;
        if (!thread) {
          thread = { id: id("thread") };
          const timestamp = reminder.delivered_at || reminder.updated_at;
          db.prepare(`
            INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
            VALUES(?,?,'sms',?,?,?,?)
          `).run(thread.id, USER_ID, reminder.recipient_phone,
            `alg_cnv_${randomUUID().replaceAll("-", "")}`, timestamp, timestamp);
        }
        const messageId = id("channel_message");
        const timestamp = reminder.delivered_at || reminder.updated_at;
        db.prepare(`
          INSERT INTO channel_messages(
            id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
          ) VALUES(?,?,'outbound','assistant',?,?,'sent',?,?,?)
        `).run(messageId, thread.id, `Reminder: ${reminder.title}`, reminder.provider_message_id,
          JSON.stringify({ kind: "reminder", reminderId: reminder.id, todoId: reminder.todo_id }),
          timestamp, timestamp);
        db.prepare("UPDATE channel_threads SET updated_at=MAX(updated_at,?) WHERE id=?")
          .run(timestamp, thread.id);
        queueIndexJob(db, "channel_message", messageId);
      }
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(10,?)").run(now());
    })();
  }
  const reminderDispatchApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=11",
  ).get();
  if (!reminderDispatchApplied) {
    // Reminder delivery now claims a dispatch row before calling Twilio, so the
    // kind CHECK has to admit 'reminder'.
    if (!dispatchKindAllows(db, "reminder")) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE scheduled_dispatches_v11 (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('daily_digest','reminder')),
            idempotency_key TEXT NOT NULL UNIQUE,
            scheduled_for TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','processing','sent','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            provider_message_id TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO scheduled_dispatches_v11 SELECT
            id,user_id,kind,idempotency_key,scheduled_for,status,attempts,
            provider_message_id,last_error,created_at,updated_at
          FROM scheduled_dispatches;
          DROP TABLE scheduled_dispatches;
          ALTER TABLE scheduled_dispatches_v11 RENAME TO scheduled_dispatches;
        `);
      })();
    }
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?)").run(now());
  }
  const briefDispatchApplied = db.prepare(
    "SELECT 1 found FROM schema_migrations WHERE version=12",
  ).get();
  if (!briefDispatchApplied) {
    // Digest briefs claim their own dispatch row per brief per local day, so the
    // kind CHECK has to admit 'digest_brief'. Same copy and rename as v11.
    if (!dispatchKindAllows(db, "digest_brief")) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE scheduled_dispatches_v12 (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('daily_digest','reminder','digest_brief')),
            idempotency_key TEXT NOT NULL UNIQUE,
            scheduled_for TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','processing','sent','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            provider_message_id TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO scheduled_dispatches_v12 SELECT
            id,user_id,kind,idempotency_key,scheduled_for,status,attempts,
            provider_message_id,last_error,created_at,updated_at
          FROM scheduled_dispatches;
          DROP TABLE scheduled_dispatches;
          ALTER TABLE scheduled_dispatches_v12 RENAME TO scheduled_dispatches;
        `);
      })();
    }
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?)").run(now());
  }
  // NeuralSearch is opt-in: it is a paid add-on, so an application without the
  // entitlement gets plain keyword search rather than a failed setup.
  const searchPreferenceTimestamp = now();
  db.prepare(`
    INSERT OR IGNORE INTO search_preferences(user_id,neural_search_enabled,created_at,updated_at)
    VALUES(?,?,?,?)
  `).run(
    USER_ID,
    process.env.ALGOLIA_NEURAL_SEARCH === "true" ? 1 : 0,
    searchPreferenceTimestamp,
    searchPreferenceTimestamp,
  );
  db.exec("CREATE INDEX IF NOT EXISTS todos_life_area ON todos(user_id,life_area_id)");
  db.exec("CREATE INDEX IF NOT EXISTS memories_life_area ON memories(user_id,life_area_id,review_worthy)");
  return db;
}

export function queueIndexJob(
  db: Db,
  entityType: EntityType,
  entityId: string,
  operation: IndexOperation = "upsert",
): string {
  const timestamp = now();
  const existing = db.prepare(`
    SELECT id FROM index_jobs
    WHERE user_id=? AND entity_type=? AND entity_id=? AND operation=?
      AND status IN ('pending','failed')
    ORDER BY created_at DESC LIMIT 1
  `).get(USER_ID, entityType, entityId, operation) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE index_jobs SET status='pending',available_at=?,last_error=NULL,updated_at=? WHERE id=?
    `).run(timestamp, timestamp, existing.id);
    return existing.id;
  }
  const jobId = id("job");
  db.prepare(`
    INSERT INTO index_jobs
      (id,user_id,entity_type,entity_id,operation,status,attempts,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',0,?,?,?)
  `).run(jobId, USER_ID, entityType, entityId, operation, timestamp, timestamp, timestamp);
  return jobId;
}

/**
 * A `LIKE` pattern for a user-supplied term. Without escaping, a `%` or `_`
 * typed into a search box would be read as a wildcard and match everything.
 */
export function likePattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function getTodo(db: Db, todoId: string): TodoRow | undefined {
  return db.prepare(`
    SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug FROM todos t
    LEFT JOIN categories c ON c.id=t.category_id
    LEFT JOIN life_areas la ON la.id=t.life_area_id
    WHERE t.id=? AND t.user_id=?
  `).get(todoId, USER_ID) as TodoRow | undefined;
}

export function getMemory(db: Db, memoryId: string): MemoryRow | undefined {
  return db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug FROM memories m
    LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.id=? AND m.user_id=?
  `).get(memoryId, USER_ID) as MemoryRow | undefined;
}

export function getChannelMessage(db: Db, messageId: string): ChannelMessageRow | undefined {
  return db.prepare(`
    SELECT m.*,t.user_id,t.channel
    FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE m.id=? AND t.user_id=?
  `).get(messageId, USER_ID) as ChannelMessageRow | undefined;
}

export function getReminders(db: Db, todoId?: string): ReminderRow[] {
  const where = todoId ? "AND r.todo_id=?" : "";
  const args = todoId ? [USER_ID, todoId] : [USER_ID];
  return db.prepare(`
    SELECT r.*,t.title todo_title FROM reminders r
    JOIN todos t ON t.id=r.todo_id WHERE r.user_id=? ${where}
    ORDER BY r.scheduled_for
  `).all(...args) as ReminderRow[];
}

/**
 * The instant a timestamp names, in one canonical spelling. A reminder row
 * holds `scheduled_for` in UTC, while a todo's `due_at`, `reminder_at`, and
 * `extra_reminders_json` keep whatever offset was written — and the agent is
 * instructed to send RFC 3339 with an explicit offset, so
 * `2026-08-06T09:00:00-04:00` and `2026-08-06T13:00:00.000Z` routinely name the
 * same moment in two spellings. Matching them as strings made a reminder
 * unfindable the moment after it was written: `create_reminder` returned
 * nothing, and the agent, handed a result with no record in it, told the user
 * it could not create reminders at all while the row sat in the database.
 */
export function instant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function syncTodoReminders(db: Db, todo: TodoRow): void {
  db.prepare("DELETE FROM reminders WHERE todo_id=? AND status IN ('pending','failed')").run(todo.id);
  if (todo.status === "done" || todo.status === "cancelled") return;
  const schedule: Array<{ at: string; kind: "due" | "pre" | "escalation" }> = [];
  if (todo.due_at) schedule.push({ at: todo.due_at, kind: "due" });
  if (todo.reminder_at) schedule.push({ at: todo.reminder_at, kind: "pre" });
  for (const at of JSON.parse(todo.extra_reminders_json) as string[]) {
    schedule.push({ at, kind: "escalation" });
  }
  const timestamp = now();
  const seen = new Set<string>();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO reminders(
      id,user_id,todo_id,scheduled_for,kind,status,available_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,'pending',?,?,?)
  `);
  for (const reminder of schedule) {
    const scheduledFor = instant(reminder.at);
    /*
     * Collapsing by timestamp alone silently ate the reminder whenever it
     * landed on the due date, which is the normal shape of "remind me to take
     * out the trash at 9pm": the agent writes the same instant to `due_at` and
     * `reminder_at`, the `due` row is built first, and the `pre` row behind it
     * looked like a duplicate. The worker never texts `due` rows, so the todo
     * kept a schedule the UI could show while no message ever went out.
     * Deduping per delivery bucket keeps that row out of the way of the one the
     * user asked for, and still collapses a `pre` and an `escalation` that
     * share an instant into the single text they are worth.
     */
    const bucket = `${reminder.kind === "due" ? "due" : "notify"}:${scheduledFor}`;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    insert.run(id("reminder"), USER_ID, todo.id, scheduledFor, reminder.kind, scheduledFor, timestamp, timestamp);
  }
}

export function resetDatabase(db: Db): void {
  db.transaction(() => {
    for (const table of [
      "scheduled_dispatches", "external_events", "channel_messages", "channel_threads",
      "reflection_selections", "reflection_exclusions", "index_jobs", "reminders", "messages", "conversations", "memories", "todos", "categories",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}

export function seedDatabase(db: Db): { seeded: true } {
  resetDatabase(db);
  const timestamp = now();
  const due = new Date(Date.now() + 86_400_000).toISOString();
  const reminder = new Date(Date.now() + 3_600_000).toISOString();
  db.transaction(() => {
    const category = db.prepare(`
      INSERT INTO categories(id,user_id,kind,name,color,icon,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `);
    category.run("cat_work", USER_ID, "todo", "Work", "#6366f1", "briefcase", timestamp, timestamp);
    category.run("cat_personal", USER_ID, "todo", "Personal", "#10b981", "home", timestamp, timestamp);
    category.run("cat_journal", USER_ID, "memory", "Journal", "#f59e0b", "book", timestamp, timestamp);
    db.prepare(`
      INSERT INTO todos(
        id,user_id,title,notes,category_id,due_at,reminder_at,extra_reminders_json,
        priority,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'[]','high','pending',?,?)
    `).run("todo_welcome", USER_ID, "Explore your assistant",
      "Try the overview, chat, and search experiences.", "cat_work", due, reminder, timestamp, timestamp);
    const todo = getTodo(db, "todo_welcome");
    if (todo) syncTodoReminders(db, todo);
    db.prepare(`
      INSERT INTO memories(
        id,user_id,title,content,kind,mood_label,mood_score,category_id,tags_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run("memory_welcome", USER_ID, "Welcome", "SQLite is the local source of truth.", "note",
      "curious", 4, "cat_journal", '["welcome","local"]', timestamp, timestamp);
    db.prepare(`
      INSERT INTO conversations(id,user_id,title,is_current,created_at,updated_at)
      VALUES(?,?,?,1,?,?)
    `).run("conversation_current", USER_ID, "Assistant", timestamp, timestamp);
    db.prepare(`
      INSERT INTO messages(
        id,conversation_id,role,content,tool_name,tool_args_json,tool_result_json,created_at
      ) VALUES(?,?,'assistant',?,NULL,NULL,NULL,?)
    `).run("message_welcome", "conversation_current", "How can I help today?", timestamp);
    queueIndexJob(db, "todo", "todo_welcome");
    queueIndexJob(db, "memory", "memory_welcome");
  })();
  return { seeded: true };
}
