export type TodoStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";
export type MemoryKind = "fact" | "note" | "journal";
export type LifeAreaSource = "agent" | "user";

export interface LifeArea {
  id: string;
  slug: string;
  name: string;
  color: string;
  is_builtin?: number | boolean;
}

export interface Category {
  id: string;
  kind: "todo" | "memory";
  name: string;
  color: string;
  icon?: string | null;
}

export interface Todo {
  id: string;
  title: string;
  notes?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  life_area_id?: string | null;
  life_area_name?: string | null;
  life_area_slug?: string | null;
  life_area_source?: LifeAreaSource | null;
  parent_id?: string | null;
  due_at?: string | null;
  reminder_at?: string | null;
  extra_reminders?: string[];
  priority?: "low" | "normal" | "high" | "urgent" | null;
  status: TodoStatus;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Memory {
  id: string;
  title?: string | null;
  content: string;
  kind: MemoryKind;
  mood_label?: string | null;
  mood_score?: number | null;
  category_id?: string | null;
  category_name?: string | null;
  life_area_id?: string | null;
  life_area_name?: string | null;
  life_area_slug?: string | null;
  life_area_source?: LifeAreaSource | null;
  occurred_at?: string | null;
  review_worthy?: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ReviewQuarterRange {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  key: string;
  label: string;
  start: string;
  endExclusive: string;
  startDate: string;
  endDate: string;
}

export interface ReviewEvidence {
  range: ReviewQuarterRange;
  memories: Memory[];
  todos: Todo[];
  memory_candidates: Memory[];
  todo_candidates: Todo[];
  draft: Memory | null;
  generated?: boolean;
}

export type ReflectionPreset = "today" | "week" | "month" | "custom";

export interface ReflectionPeriodRange {
  preset: ReflectionPreset;
  key: string;
  label: string;
  start: string;
  endExclusive: string;
  startDate: string;
  endDate: string;
  timezone: string;
}

export interface ReflectionEvidence {
  range: ReflectionPeriodRange;
  scope_key: string;
  scope: {
    life_area_ids: string[];
    category_ids: string[];
    sources: Array<"memories" | "todos">;
  };
  memories: Memory[];
  todos: Todo[];
  memory_candidates: Memory[];
  todo_candidates: Todo[];
  selected: Array<{ type: "memory" | "todo"; id: string }>;
  draft: Memory | null;
  generated?: boolean;
  generated_draft?: {
    title: string;
    content: string;
    tags: string[];
    mood_score: number | null;
    mood_label: string | null;
  };
}

export interface Reminder {
  id: string;
  todo_id: string;
  todo_title?: string;
  scheduled_for: string;
  kind: "due" | "pre" | "escalation";
  status: "pending" | "sent" | "cancelled" | "failed";
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name?: string | null;
  tool_args?: unknown;
  tool_result?: unknown;
  created_at: string;
}

export interface Overview {
  counts: Record<TodoStatus, number> & { active: number; memories: number };
  in_progress: Todo[];
  blocked: Todo[];
  due_today: Todo[];
  recent_memories: Memory[];
  upcoming_reminders: Reminder[];
  mood_trend: Array<{ at: string; score: number; label?: string | null }>;
  subtask_progress: Record<string, { done: number; total: number }>;
}

export interface Health {
  sqlite: { ok: boolean; records?: number };
  algolia: { ok: boolean; configured: boolean; error?: string; todoRecords?: number; memoryRecords?: number; messageRecords?: number };
  agentStudio: { configured: boolean; agentId?: string };
  auth: { enabled: boolean };
  neuralSearch: { enabled: boolean };
  indices: { todos: string; memories: string; messages: string };
  pendingIndexJobs: number;
}

/** Which messaging API carries outbound texts and receives inbound ones. */
export type SmsProvider = "twilio" | "sendblue";

export interface IntegrationState {
  secretStorageReady: boolean;
  twilio: {
    configured: boolean;
    status: "disconnected" | "connected" | "error";
    accountSid?: string;
    fromPhone?: string;
    webhookBaseUrl?: string;
    lastError?: string;
  };
  sendblue: {
    configured: boolean;
    status: "disconnected" | "connected" | "error";
    apiKeyId?: string;
    fromPhone?: string;
    webhookBaseUrl?: string;
    /* Sendblue webhooks are account-wide, so this is not implied by a base URL. */
    webhooksRegistered?: boolean;
    /* Sendblue acknowledges inbound iMessages itself once these are on. */
    autoTypingIndicator?: boolean;
    autoMarkRead?: boolean;
    lastError?: string;
  };
  granola: {
    configured: boolean;
    status: string;
    lastError?: string;
  };
  atlassian: {
    configured: boolean;
    status: "disconnected" | "connected" | "error";
    siteUrl: string | null;
    email: string | null;
    accountId: string | null;
    displayName: string | null;
    /* Licensed independently, so one can be false while the other is true. */
    jiraAvailable: boolean;
    confluenceAvailable: boolean;
    lastError?: string;
  };
  notifications: {
    smsEnabled: boolean;
    smsProvider: SmsProvider;
    recipientPhone: string | null;
    timezone: string;
    dailyDigestEnabled: boolean;
    dailyDigestTime: string;
    digestIncludeTodos: boolean;
    digestIncludeOverdue: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    optedOutAt: string | null;
  };
  tasks: { autoCompleteParent: boolean };
  webhookPaths: {
    sms: string;
    status: string;
    sendblueInbound: string;
    sendblueStatus: string;
  };
}

/** A Jira board or Confluence space a digest brief is scoped to. */
export interface DigestBriefResource {
  type: "jira_board" | "confluence_space";
  id: string;
  name: string | null;
}

export interface DigestBrief {
  id: string;
  name: string;
  prompt: string;
  sendTime: string;
  resources: DigestBriefResource[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalEvent {
  id: string;
  source: string;
  externalId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "processed" | "failed" | "ignored";
  attempts: number;
  lastError?: string | null;
  createdAt: string;
}

export interface ChannelConversation {
  id: string;
  channel: "web" | "sms";
  address: string;
  messageCount: number;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMessage {
  id: string;
  direction: "inbound" | "outbound";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  providerMessageId?: string | null;
  status: "received" | "queued" | "sent" | "delivered" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSearchHit {
  objectID: string;
  threadId: string;
  channel: "web" | "sms";
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ConversationSearchResult {
  source: SearchSource;
  hits: ConversationSearchHit[];
}

/** Which engine ranked a result set, so the UI can show a lexical fallback. */
export type SearchSource = "algolia" | "sqlite";

export interface MemoryListResult {
  source: SearchSource;
  memories: Memory[];
}

export type SearchHitType = "todo" | "memory" | "message";

export interface UniversalSearchHit {
  type: SearchHitType;
  objectID: string;
  title: string | null;
  snippet: string | null;
  status?: TodoStatus | null;
  priority?: string | null;
  due_at?: string | null;
  kind?: MemoryKind | null;
  mood_label?: string | null;
  mood_score?: number | null;
  tags?: string[];
  category_name?: string | null;
  life_area_name?: string | null;
  threadId?: string | null;
  channel?: "web" | "sms" | null;
  role?: "user" | "assistant" | null;
  occurred_at?: string | null;
  created_at?: string | null;
}

export interface UniversalSearchResult {
  source: SearchSource;
  counts: Record<SearchHitType, number>;
  hits: UniversalSearchHit[];
}

