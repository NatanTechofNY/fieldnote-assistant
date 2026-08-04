import type {
  Category, ChannelConversation, ChannelMessage, ConversationSearchResult, DigestBrief, DigestBriefResource,
  ExternalEvent, Health, IntegrationState, LifeArea, Memory, MemoryListResult, Message, Overview, ReflectionEvidence,
  ReflectionPreset, Reminder, ReviewEvidence, SearchHitType, SmsProvider, Todo, TodoStatus,
  UniversalSearchResult,
} from "./types";

type ApiEnvelope<T> = { success: true; data: T } | { success: false; error: string };

// Agent tool calls block the chat stream until they settle, so they get a
// deadline. Without one a dropped connection (API restart, laptop sleep) leaves
// the fetch pending forever and the chat waits on a tool that never answers.
const TOOL_TIMEOUT_MS = 20_000;

async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : null;
  const deadline = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    // The session expired or was revoked while the app was open. Never redirect
    // from the login page itself, or a misrouted /login would reload forever.
    if (response.status === 401) {
      if (window.location.pathname !== "/login") {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login?next=${next}`);
      }
      throw new Error("Authentication required");
    }
    if (response.status === 204) return undefined as T;
    const payload = (await response.json()) as ApiEnvelope<T>;
    if (!response.ok || !payload.success) {
      throw new Error("error" in payload ? payload.error : `Request failed (${response.status})`);
    }
    return payload.data;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export const api = {
  overview: () => request<Overview>("/overview"),
  health: () => request<Health>("/health"),
  todos: (includeDone = true, lifeAreaId?: string) => {
    const query = new URLSearchParams({ includeDone: String(includeDone) });
    if (lifeAreaId) query.set("life_area_id", lifeAreaId);
    return request<Todo[]>(`/todos?${query}`);
  },
  todo: (id: string) => request<{ todo: Todo; subtasks: Todo[]; reminders: Reminder[] }>(`/todos/${id}`),
  // Children come along on the create call, so a task captured with its steps
  // lands as one record with its list rather than a parent and a follow-up.
  createTodo: (input: Partial<Todo> & { title: string; subtasks?: Array<{ title: string }> }) =>
    request<Todo>("/todos", { method: "POST", body: JSON.stringify(input) }),
  updateTodo: (id: string, input: Partial<Todo>) =>
    request<Todo>(`/todos/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  setTodoStatus: (id: string, status: TodoStatus) =>
    request<Todo>(`/todos/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  deleteTodo: (id: string) => request<{ id: string }>(`/todos/${id}`, { method: "DELETE" }),
  memories: (params?: { kind?: string; query?: string; life_area_id?: string; review_worthy?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.kind && params.kind !== "all") query.set("kind", params.kind);
    if (params?.query) query.set("query", params.query);
    if (params?.life_area_id) query.set("life_area_id", params.life_area_id);
    if (params?.review_worthy !== undefined) query.set("review_worthy", String(params.review_worthy));
    return request<MemoryListResult>(`/memories?${query}`);
  },
  createMemory: (input: Partial<Memory> & { content: string }) =>
    request<Memory>("/memories", { method: "POST", body: JSON.stringify(input) }),
  updateMemory: (id: string, input: Partial<Memory>) =>
    request<Memory>(`/memories/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMemory: (id: string) => request<{ id: string }>(`/memories/${id}`, { method: "DELETE" }),
  memory: (id: string) => request<Memory>(`/memories/${id}`),
  categories: () => request<Category[]>("/categories"),
  lifeAreas: () => request<LifeArea[]>("/life-areas"),
  createLifeArea: (input: { name: string; color: string }) =>
    request<LifeArea>("/life-areas", { method: "POST", body: JSON.stringify(input) }),
  updateLifeArea: (id: string, input: { name?: string; color?: string }) =>
    request<LifeArea>(`/life-areas/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLifeArea: (id: string) =>
    request<{ id: string }>(`/life-areas/${id}`, { method: "DELETE" }),
  reviewQuarter: (year?: number, quarter?: number) => {
    const query = new URLSearchParams();
    if (year) query.set("year", String(year));
    if (quarter) query.set("quarter", String(quarter));
    return request<ReviewEvidence>(`/reviews/quarter?${query}`);
  },
  classifyReviewEvidence: (items: Array<{ type: "memory" | "todo"; id: string; included: boolean }>) =>
    request<{ changed: typeof items }>("/reviews/evidence", {
      method: "PATCH",
      body: JSON.stringify({ items }),
    }),
  reflectionPeriod: (input: {
    preset: ReflectionPreset;
    start_date?: string;
    end_date?: string;
    life_area_ids?: string[];
    category_ids?: string[];
    sources?: Array<"memories" | "todos">;
  }) => {
    const query = new URLSearchParams({ preset: input.preset });
    if (input.start_date) query.set("start_date", input.start_date);
    if (input.end_date) query.set("end_date", input.end_date);
    if (input.life_area_ids?.length) query.set("life_area_ids", input.life_area_ids.join(","));
    if (input.category_ids?.length) query.set("category_ids", input.category_ids.join(","));
    if (input.sources?.length) query.set("sources", input.sources.join(","));
    return request<ReflectionEvidence>(`/reflections/period?${query}`);
  },
  setReflectionSelections: (
    scopeKey: string,
    items: Array<{ type: "memory" | "todo"; id: string; selected: boolean }>,
  ) => request<{ changed: typeof items }>("/reflections/selections", {
    method: "PATCH",
    body: JSON.stringify({ scope_key: scopeKey, items }),
  }),
  draftReflection: (input: {
    preset: ReflectionPreset;
    start_date?: string;
    end_date?: string;
    life_area_ids?: string[];
    category_ids?: string[];
    sources?: Array<"memories" | "todos">;
  }) => request<ReflectionEvidence>("/reflections/draft", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  saveReflectionDraft: (input: {
    preset: ReflectionPreset;
    start_date?: string;
    end_date?: string;
    life_area_ids?: string[];
    category_ids?: string[];
    sources?: Array<"memories" | "todos">;
    content: string;
    tags: string[];
    mood_score: number | null;
    mood_label: string | null;
  }) => request<ReflectionEvidence>("/reflections/draft/save", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  draftReview: (year: number, quarter: number, exclusions?: { memories: string[]; todos: string[] }) =>
    request<ReviewEvidence>("/reviews/draft", {
      method: "POST",
      body: JSON.stringify({
        year,
        quarter,
        exclude_memory_ids: exclusions?.memories ?? [],
        exclude_todo_ids: exclusions?.todos ?? [],
      }),
    }),
  reminders: () => request<Reminder[]>("/reminders"),
  dueReminders: () => request<Reminder[]>("/reminders/due"),
  createReminder: (input: { todo_id: string; reminder_at: string; slot?: "primary" | "extra" }) =>
    request<Reminder>("/reminders", { method: "POST", body: JSON.stringify(input) }),
  updateReminder: (id: string, reminder_at: string) =>
    request<Reminder>(`/reminders/${id}`, { method: "PATCH", body: JSON.stringify({ reminder_at }) }),
  deleteReminder: (id: string) => request<{ id: string }>(`/reminders/${id}`, { method: "DELETE" }),
  agenda: (input: { start_date: string; end_date: string; timezone: string }) => {
    const query = new URLSearchParams(input);
    return request<{ todos: Todo[]; reminders: Reminder[] }>(`/agenda?${query}`);
  },
  messages: () => request<Message[]>("/conversations/current/messages"),
  chat: (content: string) =>
    request<{ messages: Message[]; action?: string }>("/chat", { method: "POST", body: JSON.stringify({ content }) }),
  seed: (confirmation: "SEED") => request<{ seeded: boolean }>("/admin/seed", { method: "POST", body: JSON.stringify({ confirmation }) }),
  reset: (confirmation: "RESET") => request<{ reset: boolean }>("/admin/reset", { method: "POST", body: JSON.stringify({ confirmation }) }),
  reindex: () => request<{ queued: number; processed?: number }>("/admin/reindex", { method: "POST" }),
  setupAlgolia: () => request<{ configured: boolean; details?: unknown }>("/admin/algolia/setup", { method: "POST" }),
  setNeuralSearch: (enabled: boolean) => request<{
    enabled: boolean;
    setup: { configured: boolean; details?: { neuralSearch?: string; warning?: string; error?: string } };
  }>("/admin/algolia/neural-search", { method: "PUT", body: JSON.stringify({ enabled }) }),
  syncAgentStudioTools: () => request<{
    agentId: string;
    clientTools: number;
    preservedTools: number;
    searchIndices: number;
    published: true;
  }>("/admin/agent-studio/sync-tools", { method: "POST" }),
  integrations: () => request<IntegrationState>("/integrations"),
  connectTwilio: (input: {
    accountSid: string;
    authToken?: string;
    fromPhone: string;
    webhookBaseUrl?: string;
    configureWebhook: boolean;
  }) => request<{ config: IntegrationState["twilio"]; numbers: Array<{ phoneNumber: string; friendlyName: string }> }>(
    "/integrations/twilio/connect",
    { method: "POST", body: JSON.stringify(input) },
  ),
  disconnectTwilio: () => request<{ disconnected: true }>("/integrations/twilio", { method: "DELETE" }),
  testTwilio: () => request<{ sid: string; status: string }>("/integrations/twilio/test", { method: "POST" }),
  connectSendblue: (input: {
    apiKeyId: string;
    apiSecret?: string;
    fromPhone: string;
    webhookBaseUrl?: string;
    configureWebhooks: boolean;
  }) => request<{
    config: IntegrationState["sendblue"];
    lines: Array<{ phoneNumber: string; label: string | null }>;
    /** Why typing indicators or read receipts stayed off, when they did. */
    notes: string[];
  }>("/integrations/sendblue/connect", { method: "POST", body: JSON.stringify(input) }),
  disconnectSendblue: () => request<{ disconnected: true }>("/integrations/sendblue", { method: "DELETE" }),
  testSendblue: () => request<{ sid: string; status: string }>("/integrations/sendblue/test", { method: "POST" }),
  /* The provider is a connection choice, so it saves on click rather than with the schedule. */
  setSmsProvider: (provider: SmsProvider) =>
    request<IntegrationState["notifications"]>("/integrations/sms-provider", {
      method: "PUT",
      body: JSON.stringify({ provider }),
    }),
  updateTaskPreferences: (input: IntegrationState["tasks"]) =>
    request<IntegrationState["tasks"]>("/integrations/tasks", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  updateNotifications: (input: Omit<IntegrationState["notifications"], "optedOutAt" | "smsProvider">) =>
    request<IntegrationState["notifications"]>("/integrations/notifications", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  connectGranola: (apiKey: string) => request<{ config: IntegrationState["granola"]; poll: unknown }>(
    "/integrations/granola/connect",
    { method: "POST", body: JSON.stringify({ apiKey }) },
  ),
  disconnectGranola: () => request<{ disconnected: true }>("/integrations/granola", { method: "DELETE" }),
  pollGranola: () => request<{ fetched: number; queued: number }>("/integrations/granola/poll", { method: "POST" }),
  connectAtlassian: (input: { siteUrl: string; email: string; apiToken: string }) =>
    request<{ config: IntegrationState["atlassian"] }>("/integrations/atlassian/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  disconnectAtlassian: () => request<{ disconnected: true }>("/integrations/atlassian", { method: "DELETE" }),
  digestBriefs: () => request<DigestBrief[]>("/digest-briefs"),
  createDigestBrief: (input: {
    name: string;
    prompt: string;
    sendTime: string;
    resources: DigestBriefResource[];
    enabled: boolean;
  }) => request<DigestBrief>("/digest-briefs", { method: "POST", body: JSON.stringify(input) }),
  updateDigestBrief: (id: string, input: Partial<{
    name: string;
    prompt: string;
    sendTime: string;
    resources: DigestBriefResource[];
    enabled: boolean;
  }>) => request<DigestBrief>(`/digest-briefs/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteDigestBrief: (id: string) =>
    request<{ id: string }>(`/digest-briefs/${id}`, { method: "DELETE" }),
  /*
   * A preview runs the brief's own tool calls, so it needs the agent-tool
   * deadline rather than the default one. Nothing is texted.
   */
  testDigestBrief: (id: string) => request<{ text: string; sent: false; date: string; timezone: string }>(
    `/digest-briefs/${id}/test`,
    { method: "POST" },
    TOOL_TIMEOUT_MS * 3,
  ),
  /*
   * The picker reads Atlassian through the agent tool endpoint rather than a
   * dedicated REST route, so the UI and the agent see exactly the same boards
   * and spaces.
   */
  jiraBoards: (nameFilter: string) => request<{
    boards: Array<{ id: number; name: string | null; project_key: string | null }>;
  }>("/agent/tools/list_jira_boards", {
    method: "POST",
    body: JSON.stringify({ name_filter: nameFilter || null, limit: 25 }),
  }, TOOL_TIMEOUT_MS),
  confluenceSpaces: () => request<{
    spaces: Array<{ id: string | null; key: string | null; name: string | null }>;
  }>("/agent/tools/list_confluence_spaces", {
    method: "POST",
    body: JSON.stringify({ limit: 100 }),
  }, TOOL_TIMEOUT_MS),
  integrationEvents: () => request<ExternalEvent[]>("/integrations/events"),
  reviewEvent: (id: string, action: "create_memory" | "ignore") =>
    request<unknown>(`/integrations/events/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  executeAgentTool: (name: string, input: unknown) =>
    request<unknown>(`/agent/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(input),
    }, TOOL_TIMEOUT_MS),
  channelConversations: () => request<ChannelConversation[]>("/conversations/channels"),
  channelMessages: (threadId: string) =>
    request<ChannelMessage[]>(`/conversations/channels/${encodeURIComponent(threadId)}/messages`),
  searchConversations: (query: string, limit = 20) =>
    request<ConversationSearchResult>(`/conversations/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  universalSearch: (searchQuery: string, options?: { types?: SearchHitType[]; limit?: number }) => {
    const query = new URLSearchParams({ q: searchQuery });
    if (options?.types?.length) query.set("types", options.types.join(","));
    if (options?.limit) query.set("limit", String(options.limit));
    return request<UniversalSearchResult>(`/search?${query}`);
  },
  /*
   * `conversationId` keys the archive thread and stays put, so the browser keeps
   * one continuous timeline. `agentConversationId` is the id Agent Studio filed
   * this sitting under, which rotates, and is what makes a thread traceable to a
   * conversation on Algolia's side.
   */
  syncWebConversation: (
    messages: Array<{ id: string; role: "user" | "assistant"; parts: Array<Record<string, unknown>> }>,
    agentConversationId?: string,
  ) =>
    request<{ threadId: string; messages: number }>("/conversations/web/sync", {
      method: "POST",
      body: JSON.stringify({ conversationId: "browser-agent", agentConversationId, messages }),
    }),
};

