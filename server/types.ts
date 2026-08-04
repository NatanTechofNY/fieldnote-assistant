import type Database from "better-sqlite3";

export const USER_ID = process.env.DEMO_USER_ID || "devcon-demo";

export type Db = Database.Database;
export type TodoStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent" | null;
export type MemoryKind = "fact" | "note" | "journal";
export type LifeAreaSource = "agent" | "user";
export type EntityType = "todo" | "memory" | "channel_message";
export type IndexOperation = "upsert" | "delete";

export interface TodoRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  category_id: string | null;
  life_area_id: string | null;
  life_area_source: LifeAreaSource | null;
  parent_id: string | null;
  due_at: string | null;
  reminder_at: string | null;
  extra_reminders_json: string;
  priority: Priority;
  status: TodoStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  category_name?: string | null;
  life_area_name?: string | null;
  life_area_slug?: string | null;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  title: string | null;
  content: string;
  kind: MemoryKind;
  mood_label: string | null;
  mood_score: number | null;
  category_id: string | null;
  life_area_id: string | null;
  life_area_source: LifeAreaSource | null;
  occurred_at: string | null;
  review_worthy: 0 | 1;
  tags_json: string;
  created_at: string;
  updated_at: string;
  category_name?: string | null;
  life_area_name?: string | null;
  life_area_slug?: string | null;
}

export interface LifeAreaRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface ReminderRow {
  id: string;
  user_id: string;
  todo_id: string;
  scheduled_for: string;
  kind: "due" | "pre" | "escalation";
  status: "pending" | "sent" | "cancelled" | "failed";
  delivered_at: string | null;
  claimed_at: string | null;
  available_at: string | null;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  todo_title?: string;
}

export interface IntegrationSettingRow {
  user_id: string;
  provider: string;
  config_json: string;
  encrypted_secret: string | null;
  status: "disconnected" | "connected" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationPreferencesRow {
  user_id: string;
  sms_enabled: 0 | 1;
  sms_provider: "twilio" | "sendblue";
  recipient_phone: string | null;
  timezone: string;
  daily_digest_enabled: 0 | 1;
  daily_digest_time: string;
  digest_include_todos: 0 | 1;
  digest_include_overdue: 0 | 1;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  opted_out_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A pinned Jira board or Confluence space a brief is allowed to talk about. */
export interface DigestBriefResource {
  type: "jira_board" | "confluence_space";
  id: string;
  name: string | null;
}

export interface DigestBriefRow {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  send_time: string;
  resources_json: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface ExternalEventRow {
  id: string;
  user_id: string;
  source: string;
  external_id: string;
  event_type: string;
  payload_json: string;
  status: "pending" | "processing" | "processed" | "failed" | "ignored";
  attempts: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  tool_args_json: string | null;
  tool_result_json: string | null;
  created_at: string;
}

export interface ChannelMessageRow {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  provider_message_id: string | null;
  status: "received" | "queued" | "sent" | "delivered" | "failed";
  metadata_json: string;
  created_at: string;
  updated_at: string;
  user_id?: string;
  channel?: "web" | "sms";
}

export interface IndexJobRow {
  id: string;
  user_id: string;
  entity_type: EntityType;
  entity_id: string;
  operation: IndexOperation;
  status: "pending" | "processing" | "failed" | "done";
  attempts: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
