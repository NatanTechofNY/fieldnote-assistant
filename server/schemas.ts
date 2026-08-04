import { z } from "zod";

/* Shared primitives ---------------------------------------------------------- */

export const iso = z.string().datetime({ offset: true });
export const nullableIso = iso.nullable().optional();
export const nullableId = z.string().min(1).max(100).nullable().optional();
export const priority = z.enum(["low", "normal", "high", "urgent"]).nullable();
export const status = z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]);
export const memoryKind = z.enum(["fact", "note", "journal"]);
export const lifeAreaSource = z.enum(["agent", "user"]);

export const e164 = z.string().regex(
  /^\+[1-9]\d{7,14}$/,
  "Use an E.164 phone number such as +17185551234",
);

export const publicHttpsUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const isLocalHostname = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  if (url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Webhook URL must use HTTPS" });
  }
  if (isLocalHostname) {
    context.addIssue({
      code: "custom",
      message: "Twilio cannot reach localhost. Use a public HTTPS URL from ngrok, Cloudflare Tunnel, or your deployed app",
    });
  }
});

export const timezone = z.string().min(1).max(100).refine(value => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Select a valid IANA timezone");

/* REST request schemas ------------------------------------------------------- */

export const subtaskCreate = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20_000).nullable().optional(),
  priority: priority.optional(),
  due_at: nullableIso,
}).strict();

export const todoCreate = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20_000).nullable().optional(),
  category_id: nullableId,
  life_area_id: nullableId,
  life_area_source: lifeAreaSource.nullable().optional(),
  parent_id: nullableId,
  due_at: nullableIso,
  reminder_at: nullableIso,
  extra_reminders: z.array(iso).max(20).default([]),
  priority: priority.optional(),
  status: status.default("pending"),
  started_at: nullableIso,
  completed_at: nullableIso,
  subtasks: z.array(subtaskCreate).max(50).nullable().optional(),
}).strict();

export const todoPatch = todoCreate.omit({ subtasks: true }).partial()
  .refine((value) => Object.keys(value).length > 0, "No changes provided");

export const memoryCreate = z.object({
  title: z.string().trim().max(300).nullable().optional(),
  content: z.string().trim().min(1).max(50_000),
  kind: memoryKind.default("note"),
  mood_label: z.string().trim().min(1).max(100).nullable().optional(),
  mood_score: z.number().int().min(1).max(5).nullable().optional(),
  category_id: nullableId,
  life_area_id: nullableId,
  life_area_source: lifeAreaSource.nullable().optional(),
  occurred_at: nullableIso,
  review_worthy: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
}).strict();

export const memoryPatch = memoryCreate.partial()
  .refine((value) => Object.keys(value).length > 0, "No changes provided");

export const categoryCreate = z.object({
  kind: z.enum(["todo", "memory"]),
  name: z.string().trim().min(1).max(100),
  color: z.string().trim().min(1).max(40),
  icon: z.string().trim().max(80).nullable().optional(),
}).strict();

export const lifeAreaCreate = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color"),
}).strict();

export const reminderCreate = z.object({
  todo_id: z.string().min(1).max(100),
  reminder_at: iso,
  slot: z.enum(["primary", "extra"]).default("primary"),
}).strict();

/**
 * The auth token is optional so an already-connected account can edit the
 * number or webhook URL without re-pasting a credential the browser never
 * receives back; the route falls back to the stored token.
 */
export const twilioConfigInput = z.object({
  accountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/, "Invalid Twilio Account SID"),
  authToken: z.string().min(16).max(200).optional(),
  fromPhone: e164,
  webhookBaseUrl: publicHttpsUrl.optional(),
  configureWebhook: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.configureWebhook && !value.webhookBaseUrl) {
    context.addIssue({
      code: "custom",
      path: ["webhookBaseUrl"],
      message: "A public HTTPS URL is required to configure Twilio webhooks",
    });
  }
});

/**
 * Sendblue issues an opaque key pair rather than a structured SID, so only the
 * shape is checked. The secret is optional for the same reason as the Twilio auth
 * token, and `configureWebhooks` is opt-in because registering the inbound URL
 * replaces it for every line on the account, not just the one being connected.
 */
export const sendblueConfigInput = z.object({
  apiKeyId: z.string().trim().min(8).max(200),
  apiSecret: z.string().trim().min(8).max(500).optional(),
  fromPhone: e164,
  webhookBaseUrl: publicHttpsUrl.optional(),
  configureWebhooks: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.configureWebhooks && !value.webhookBaseUrl) {
    context.addIssue({
      code: "custom",
      path: ["webhookBaseUrl"],
      message: "A public HTTPS URL is required to configure Sendblue webhooks",
    });
  }
});

export const smsProviderInput = z.object({
  provider: z.enum(["twilio", "sendblue"]),
}).strict();

export const taskPreferencesInput = z.object({
  autoCompleteParent: z.boolean(),
}).strict();

/**
 * A classic API token authenticates against the site host itself, so the origin
 * is all that is kept: a pasted deep link would otherwise be prefixed onto every
 * request path.
 */
export const atlassianConfigInput = z.object({
  siteUrl: z.string().trim().url().superRefine((value, context) => {
    if (new URL(value).protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Atlassian site URL must use HTTPS" });
    }
  }).transform(value => new URL(value).origin),
  email: z.string().trim().email(),
  apiToken: z.string().min(8).max(500),
}).strict();

export const clockTime = z.string().regex(/^\d{2}:\d{2}$/, "Use a 24-hour HH:MM time");

/**
 * A brief pins the boards and spaces it concerns so the worker can hand the agent
 * an enumerated list instead of leaving it to guess an opaque ID from the prompt
 * wording.
 */
export const digestBriefResource = z.object({
  type: z.enum(["jira_board", "confluence_space"]),
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().max(200).nullable().optional(),
}).strict();

export const digestBriefCreate = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  sendTime: clockTime.default("08:00"),
  resources: z.array(digestBriefResource).max(20).default([]),
  enabled: z.boolean().default(true),
}).strict();

/*
 * Spelled out rather than derived with `.partial()`, because `.partial()` keeps
 * the create defaults: an absent key would still parse to `08:00`, `[]`, `true`
 * and the patch would overwrite the send time, unpin every board, and re-enable
 * a disabled brief. Every field here is optional with no default, so an absent
 * key stays absent and the handler falls back to the stored row.
 */
export const digestBriefPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  sendTime: clockTime.optional(),
  resources: z.array(digestBriefResource).max(20).optional(),
  enabled: z.boolean().optional(),
}).strict()
  .refine((value) => Object.keys(value).length > 0, "No changes provided");

export const notificationInput = z.object({
  smsEnabled: z.boolean(),
  recipientPhone: e164.nullable(),
  timezone,
  dailyDigestEnabled: z.boolean(),
  dailyDigestTime: z.string().regex(/^\d{2}:\d{2}$/),
  digestIncludeTodos: z.boolean().default(false),
  digestIncludeOverdue: z.boolean().default(false),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
}).strict();

/* Agent tool input schemas --------------------------------------------------- */

/*
 * These mirror `agent-studio/tools/client-tools.json`, which uses OpenAI strict
 * function schemas: every field is listed as required and unset values arrive as
 * null. Keys are therefore optional here while their values are validated as
 * strictly as the REST equivalents, so a partial call from the tool endpoint
 * still works but a bad enum or malformed timestamp never reaches SQLite.
 */

const entityId = z.string().min(1).max(100);
const confirmable = { confirmed: z.boolean().optional() };
const overridable = { override_user_classification: z.boolean().optional() };

const todoToolFields = {
  title: z.string().trim().min(1).max(300).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  priority: priority.optional(),
  category_id: nullableId,
  life_area_id: nullableId,
  parent_id: nullableId,
  due_at: nullableIso,
  reminder_at: nullableIso,
  extra_reminders: z.array(iso).max(20).nullable().optional(),
};

const memoryToolFields = {
  kind: memoryKind.optional(),
  title: z.string().trim().max(300).nullable().optional(),
  content: z.string().trim().min(1).max(50_000).optional(),
  mood_label: z.string().trim().min(1).max(100).nullable().optional(),
  mood_score: z.number().int().min(1).max(5).nullable().optional(),
  category_id: nullableId,
  life_area_id: nullableId,
  occurred_at: nullableIso,
  review_worthy: z.boolean().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).nullable().optional(),
};

const clearFields = <T extends readonly [string, ...string[]]>(values: T) =>
  z.array(z.enum(values)).optional();

/* Atlassian tool primitives. Every filter here is a hard filter on a remote
 * system, so each one stays bounded and the free-text fields stay short. */
const spaceKeys = z.array(z.string().trim().min(1).max(60)).max(20).nullable().optional();
const searchText = z.string().trim().min(1).max(300).nullable().optional();
const withinDays = (max: number) => z.coerce.number().int().min(1).max(max).nullable().optional();
const resultLimit = (max: number) => z.coerce.number().int().min(1).max(max).nullable().optional();

export const toolInput = {
  list_life_areas: z.object({}),
  get_review_evidence: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    quarter: z.coerce.number().int().min(1).max(4),
    timezone,
  }),
  get_reflection_evidence: z.object({
    preset: z.enum(["today", "week", "month", "custom"]),
    start_date: z.string().min(1).nullable().optional(),
    end_date: z.string().min(1).nullable().optional(),
    timezone,
    life_area_ids: z.array(z.string().min(1)).nullable().optional(),
    category_ids: z.array(z.string().min(1)).nullable().optional(),
    sources: z.array(z.enum(["memories", "todos"])).nullable().optional(),
  }),
  get_todo: z.object({ id: entityId }),
  list_todos: z.object({
    status: status.nullable().optional(),
    priority: priority.optional(),
    category_id: nullableId,
    life_area_id: nullableId,
    parent_id: nullableId,
    due_from: nullableIso,
    due_to: nullableIso,
    limit: z.coerce.number().int().min(1).max(200).nullable().optional(),
  }),
  create_todo: z.object({
    ...todoToolFields,
    title: z.string().trim().min(1).max(300),
    subtasks: z.array(z.object({
      title: z.string().trim().min(1).max(300),
      notes: z.string().max(20_000).nullable().optional(),
      priority: priority.optional(),
      due_at: nullableIso,
    })).max(50).nullable().optional(),
  }),
  update_todo: z.object({
    id: entityId,
    patch: z.object({
      ...todoToolFields,
      clear_fields: clearFields([
        "notes", "priority", "category_id", "life_area_id",
        "parent_id", "due_at", "reminder_at", "extra_reminders",
      ]),
    }).default({}),
    ...overridable,
  }),
  set_todo_status: z.object({ id: entityId, status }),
  delete_todo: z.object({ id: entityId, ...confirmable }),
  get_memory: z.object({ id: entityId }),
  create_memory: z.object({
    ...memoryToolFields,
    content: z.string().trim().min(1).max(50_000),
  }),
  update_memory: z.object({
    id: entityId,
    patch: z.object({
      ...memoryToolFields,
      clear_fields: clearFields([
        "title", "mood_label", "mood_score", "category_id",
        "life_area_id", "occurred_at", "tags",
      ]),
    }).default({}),
    ...overridable,
  }),
  delete_memory: z.object({ id: entityId, ...confirmable }),
  get_agenda: z.object({
    start_date: z.string().min(1),
    end_date: z.string().min(1),
    timezone: timezone.optional(),
  }),
  get_conversation_context: z.object({
    thread_id: entityId,
    message_id: z.string().min(1).max(100).nullable().optional(),
    limit: z.coerce.number().int().min(1).max(40).nullable().optional(),
  }),
  create_reminder: z.object({
    todo_id: entityId,
    reminder_at: iso,
    slot: z.enum(["primary", "extra"]).default("primary"),
  }),
  list_reminders: z.object({
    from: iso,
    to: iso,
    limit: z.coerce.number().int().min(1).max(100).nullable().optional(),
  }),
  update_reminder: z.object({ id: entityId, reminder_at: iso }),
  delete_reminder: z.object({ id: entityId, ...confirmable }),
  list_jira_boards: z.object({
    name_filter: z.string().trim().min(1).max(200).nullable().optional(),
    project_key: z.string().trim().min(1).max(100).nullable().optional(),
    include_columns: z.boolean().nullable().optional(),
    limit: resultLimit(50),
  }),
  list_jira_issues: z.object({
    board_id: z.coerce.number().int().positive().nullable().optional(),
    // "me" or an accountId from list_jira_users. Jira rejects usernames outright.
    assignee: z.string().trim().min(1).max(150).nullable().optional(),
    project_key: z.string().trim().min(1).max(100).nullable().optional(),
    status_ids: z.array(z.string().trim().min(1).max(40)).max(20).nullable().optional(),
    text: searchText,
    updated_within_days: withinDays(365),
    limit: resultLimit(50),
  }),
  get_jira_issue: z.object({
    key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, "Use a Jira issue key such as ABC-123"),
    include_recent_changes: z.boolean().nullable().optional(),
  }),
  list_jira_users: z.object({
    query: z.string().trim().min(1).max(150),
    limit: resultLimit(50),
  }),
  list_confluence_spaces: z.object({
    keys: spaceKeys,
    limit: resultLimit(100),
  }),
  list_confluence_pages: z.object({
    space_keys: spaceKeys,
    text: searchText,
    modified_within_days: withinDays(365),
    mine_only: z.boolean().nullable().optional(),
    limit: resultLimit(50),
  }),
  get_confluence_page: z.object({
    id: z.string().trim().regex(/^\d+$/, "Confluence page IDs are numeric"),
  }),
  list_confluence_comments: z.object({
    space_keys: spaceKeys,
    within_days: withinDays(30),
    only_my_pages: z.boolean().nullable().optional(),
    limit: resultLimit(100),
  }),
} as const;

export type ToolName = keyof typeof toolInput;
