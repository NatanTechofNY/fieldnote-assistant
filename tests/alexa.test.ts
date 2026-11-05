import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import request from "supertest";
import type { AlgoliaSync } from "../server/algolia.ts";
import {
  closeAlexaControl, resetAlexaState, setAlexaClient, type AlexaToolClient,
} from "../server/alexa-control.ts";
import { createApp } from "../server/app.ts";
import { resetThrottling } from "../server/auth.ts";
import { ensureGroupLifeArea, openDatabase, USER_ID } from "../server/db.ts";
import { HOUSEHOLD_ADDRESS } from "../server/group-thread.ts";
import { isVoiceThread } from "../server/household.ts";
import { localParts } from "../server/local-time.ts";
import { getSearchPreferences, saveNotificationPreferences, saveSendblueConfig, setSmsProvider } from "../server/integrations.ts";
import { resetOAuthThrottle } from "../server/routes/alexa-oauth.ts";
import { resetMcpThrottle } from "../server/routes/alexa-mcp.ts";
import { executeAgentTool, type ToolTurnContext } from "../server/tool-executor.ts";
import type { Db } from "../server/types.ts";
import { runWorkerOnce } from "../server/worker.ts";

process.env.SETTINGS_ENCRYPTION_KEY = "test-only-encryption-key";
process.env.NODE_ENV = "test";

const PASSWORD = "correct-horse-battery-staple";
const BASE = "https://fieldnote.example.com";
const RESOURCE = `${BASE}/mcp`;
const CLIENT_ID = "alexa-client";
const CLIENT_SECRET = "a-long-client-secret";
const REDIRECT = "https://pitangui.amazon.com/api/skill/link/M123ABC";
const OWNER = "+17185551111";

const databases: Db[] = [];

function fakeSearch(db: Db) {
  return {
    searchAll: undefined as AlgoliaSync["searchAll"] | undefined,
    searchMemories: undefined as AlgoliaSync["searchMemories"] | undefined,
    flushSoon() {},
    async flush() { return { configured: false, processed: 0, succeeded: 0, failed: 0 }; },
    async reindex() { return { queued: 0, processed: 0 }; },
    neuralSearchEnabled() { return getSearchPreferences(db).neuralSearchEnabled; },
    async setup() { return { configured: false, details: { reason: "test" } }; },
    async health() { return { ok: true, configured: false }; },
  };
}

function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const search = fakeSearch(db);
  saveNotificationPreferences(db, {
    smsEnabled: true, recipientPhone: OWNER, timezone: "America/New_York", dailyDigestEnabled: false, dailyDigestTime: "09:00",
    quietHoursStart: null, quietHoursEnd: null,
  });
  const { app } = createApp({ db, search });
  return { db, search, app, api: request(app) };
}

/** One listening server for a test that sends hundreds of requests, instead of a new one for each. */
async function withServer(app: Parameters<typeof request>[0], run: (api: Api) => Promise<void>): Promise<void> {
  const server = (app as { listen: (port: number) => import("node:http").Server }).listen(0);
  try {
    await run(request(server));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function configure(): void {
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.APP_ADMIN_PASSWORD = PASSWORD;
  process.env.ALEXA_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.ALEXA_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
  resetThrottling();
  resetOAuthThrottle();
  resetMcpThrottle();
}

const ENV_KEYS = [
  "PUBLIC_BASE_URL", "APP_ADMIN_PASSWORD", "ALEXA_OAUTH_CLIENT_ID", "ALEXA_OAUTH_CLIENT_SECRET", "ALEXA_OAUTH_REDIRECT_URIS",
  "ALEXA_REFRESH_TOKEN", "ALEXA_MCP_PATH", "ALEXA_DAILY_LIMIT", "ALEXA_BLOCKED_DEVICES", "ALEXA_ALLOWED_ROUTINES", "ALEXA_TIMEOUT_MS",
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  for (const key of ENV_KEYS) delete process.env[key];
  setAlexaClient();
  resetAlexaState();
  resetThrottling();
  resetOAuthThrottle();
  resetMcpThrottle();
});

/* Account linking ---------------------------------------------------------------- */

type Api = ReturnType<typeof fixture>["api"];

const unescapeHtml = (value: string) => value.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function signIn(api: Api): Promise<string> {
  const login = await api.post("/login").type("form").send({ password: PASSWORD }).expect(302);
  return login.headers["set-cookie"][0] as string;
}

function authorizeQuery(challenge: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", resource: RESOURCE, state: "st8", scope: "household", ...overrides,
  };
}

/** Walks the consent page as the signed-in owner and returns the code Amazon would receive. */
async function approve(api: Api, cookie: string, challenge: string, overrides: Record<string, string> = {}): Promise<string> {
  const page = await api.get("/oauth/authorize").set("Cookie", cookie).query(authorizeQuery(challenge, overrides)).expect(200);
  assert.match(page.text, /Household/);
  const form: Record<string, string> = {};
  for (const [, name, value] of page.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form[name] = unescapeHtml(value);
  const done = await api.post("/oauth/authorize").set("Cookie", cookie).type("form").send({ ...form, decision: "allow" }).expect(302);
  const target = new URL(done.headers.location as string);
  assert.equal(`${target.origin}${target.pathname}`, overrides.redirect_uri ?? REDIRECT);
  assert.equal(target.searchParams.get("state"), "st8");
  const code = target.searchParams.get("code");
  assert.ok(code, "an approved link comes back with a code");
  return code;
}

type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number };

function tokenRequest(api: Api, fields: Record<string, string>, secret = CLIENT_SECRET) {
  return api.post("/oauth/token").auth(CLIENT_ID, secret).type("form").send(fields);
}

async function link(api: Api): Promise<{ tokens: Tokens; cookie: string }> {
  const cookie = await signIn(api);
  const { verifier, challenge } = pkce();
  const code = await approve(api, cookie, challenge);
  const response = await tokenRequest(api, {
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE,
  }).expect(200);
  return { tokens: response.body as Tokens, cookie };
}

describe("Alexa account linking", () => {
  it("publishes discovery documents only once linking is configured", async () => {
    const { api } = fixture();
    process.env.PUBLIC_BASE_URL = BASE;
    await api.get("/.well-known/oauth-authorization-server").expect(404);
    await api.get("/.well-known/oauth-protected-resource").expect(404);
    configure();
    const server = (await api.get("/.well-known/oauth-authorization-server").expect(200)).body;
    assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
    assert.equal(server.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(server.token_endpoint, `${BASE}/oauth/token`);
    const resource = (await api.get("/.well-known/oauth-protected-resource").expect(200)).body;
    assert.equal(resource.resource, RESOURCE);
    assert.deepEqual(resource.authorization_servers, [BASE]);
    assert.equal((await api.get("/.well-known/oauth-protected-resource/mcp").expect(200)).body.resource, RESOURCE);
  });

  it("takes the owner's own session to approve a link, and never offers one without a password", async () => {
    configure();
    const { api } = fixture();
    const { challenge } = pkce();
    const anonymous = await api.get("/oauth/authorize").query(authorizeQuery(challenge)).expect(302);
    assert.match(anonymous.headers.location as string, /^\/login/, "a visitor with no session is sent to sign in first");
    await api.post("/oauth/authorize").type("form").send({ ...authorizeQuery(challenge), decision: "allow" }).expect(401);

    delete process.env.APP_ADMIN_PASSWORD;
    const open = await api.get("/oauth/authorize").query(authorizeQuery(challenge)).expect(503);
    assert.match(open.text, /APP_ADMIN_PASSWORD/);
  });

  it("refuses an authorization request that skips PKCE, names another client, address or resource", async () => {
    configure();
    const { api } = fixture();
    const cookie = await signIn(api);
    const { challenge } = pkce();
    const get = (overrides: Record<string, string>) =>
      api.get("/oauth/authorize").set("Cookie", cookie).query(authorizeQuery(challenge, overrides));
    await get({ code_challenge_method: "plain" }).expect(400);
    await get({ code_challenge: "short" }).expect(400);
    await get({ client_id: "someone-else" }).expect(400);
    await get({ redirect_uri: "https://evil.example.com/cb" }).expect(400);
    await get({ redirect_uri: "https://alexa.amazon.com.evil.example.com/api/skill/link/M1" }).expect(400);
    await get({ resource: "https://fieldnote.example.com/api" }).expect(400);
    await get({ response_type: "token" }).expect(400);
    process.env.ALEXA_OAUTH_REDIRECT_URIS = "https://alexa.amazon.com/api/skill/link/ONLYTHIS";
    await get({}).expect(400);
    await get({ redirect_uri: "https://alexa.amazon.com/api/skill/link/ONLYTHIS" }).expect(200);
  });

  it("refuses an approval the consent page was not drawn for", async () => {
    configure();
    const { api } = fixture();
    const cookie = await signIn(api);
    const { challenge } = pkce();
    const forged = { ...authorizeQuery(challenge), consent_expires: String(Date.now() + 60_000), consent_mac: "0".repeat(64), decision: "allow" };
    await api.post("/oauth/authorize").set("Cookie", cookie).type("form").send(forged).expect(400);
  });

  it("sends a denial back to Amazon without a code", async () => {
    configure();
    const { api } = fixture();
    const cookie = await signIn(api);
    const { challenge } = pkce();
    const page = await api.get("/oauth/authorize").set("Cookie", cookie).query(authorizeQuery(challenge)).expect(200);
    const form: Record<string, string> = {};
    for (const [, name, value] of page.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form[name] = unescapeHtml(value);
    const denied = await api.post("/oauth/authorize").set("Cookie", cookie).type("form").send({ ...form, decision: "deny" }).expect(302);
    const target = new URL(denied.headers.location as string);
    assert.equal(target.searchParams.get("error"), "access_denied");
    assert.equal(target.searchParams.get("code"), null);
  });

  it("exchanges a code once, and only for the verifier, address and resource it was issued for", async () => {
    configure();
    const { api } = fixture();
    const cookie = await signIn(api);
    const { verifier, challenge } = pkce();
    const exchange = (code: string, overrides: Record<string, string> = {}) => tokenRequest(api, {
      grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE, ...overrides,
    });

    // Every failed attempt spends the code, so a guess cannot be retried with a better one.
    let code = await approve(api, cookie, challenge);
    assert.equal((await exchange(code, { code_verifier: pkce().verifier }).expect(400)).body.error, "invalid_grant");
    assert.equal((await exchange(code).expect(400)).body.error, "invalid_grant");

    code = await approve(api, cookie, challenge);
    assert.equal((await exchange(code, { resource: `${BASE}/other` }).expect(400)).body.error, "invalid_target");
    code = await approve(api, cookie, challenge);
    assert.equal((await exchange(code, { redirect_uri: "https://pitangui.amazon.com/api/skill/link/OTHER" }).expect(400)).body.error, "invalid_grant");

    code = await approve(api, cookie, challenge);
    const good = await exchange(code).expect(200);
    assert.equal(good.body.token_type, "Bearer");
    assert.equal(good.headers["cache-control"], "no-store");
    assert.equal((await exchange(code).expect(400)).body.error, "invalid_grant", "a code works once");
  });

  it("authenticates the client by Basic or by form, and by nothing else", async () => {
    configure();
    const { api } = fixture();
    const cookie = await signIn(api);
    const { verifier, challenge } = pkce();
    const fields = (code: string) => ({
      grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE,
    });
    await tokenRequest(api, fields(await approve(api, cookie, challenge)), "wrong-secret").expect(401);
    await api.post("/oauth/token").type("form").send(fields(await approve(api, cookie, challenge))).expect(401);
    await api.post("/oauth/token").type("form")
      .send({ ...fields(await approve(api, cookie, challenge)), client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).expect(200);
    await api.post("/oauth/token").auth(CLIENT_ID, CLIENT_SECRET).type("form").send({ grant_type: "password" }).expect(400);
  });

  it("rotates the refresh token, so the old pair stops working the moment the new one exists", async () => {
    configure();
    const { api } = fixture();
    const { tokens } = await link(api);
    const call = (token: string) => api.post("/mcp").set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await call(tokens.access_token).expect(200);

    const refreshed = (await tokenRequest(api, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: RESOURCE }).expect(200)).body as Tokens;
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    await call(refreshed.access_token).expect(200);
    await call(tokens.access_token).expect(401);
    assert.equal((await tokenRequest(api, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }).expect(400)).body.error, "invalid_grant");
    assert.equal((await tokenRequest(api, { grant_type: "refresh_token", refresh_token: refreshed.refresh_token, resource: `${BASE}/other` }).expect(400)).body.error, "invalid_target");
  });

  it("throttles refused token requests, and never a good one", async () => {
    configure();
    const { app } = fixture();
    let last = 0;
    // One listener for all of them: sixty-one servers opened back to back reset a connection now and then.
    await withServer(app, async live => {
      for (let attempt = 0; attempt < 61; attempt += 1) {
        last = (await tokenRequest(live, { grant_type: "refresh_token", refresh_token: "nope" })).status;
      }
    });
    assert.equal(last, 429);
  });

  it("is not shut out of the token endpoint by a flood of bad requests from the same address", async () => {
    configure();
    const { api, app } = fixture();
    const { tokens } = await link(api);
    await withServer(app, async live => {
      for (let attempt = 0; attempt < 70; attempt += 1) await tokenRequest(live, { grant_type: "refresh_token", refresh_token: "nope" }, "wrong-secret");
      await tokenRequest(live, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: RESOURCE }).expect(200);
    });
  });

  it("shows the link in Settings and revokes it on request", async () => {
    configure();
    const { api } = fixture();
    const { tokens, cookie } = await link(api);
    const before = (await api.get("/api/integrations/alexa").set("Cookie", cookie).expect(200)).body.data;
    assert.equal(before.linking.configured, true);
    assert.equal(before.linking.resource, RESOURCE);
    assert.equal(before.linking.area, "Household");
    assert.ok(before.linking.linkedSince);
    assert.deepEqual(before.control, { configured: false }, "device control is separate, and reports its own state");

    await api.delete("/api/integrations/alexa/link").set("Cookie", cookie).expect(200);
    assert.equal((await api.get("/api/integrations/alexa").set("Cookie", cookie).expect(200)).body.data.linking.linkedSince, null);
    await api.post("/mcp").set("Authorization", `Bearer ${tokens.access_token}`)
      .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
  });
});

/* The gate ------------------------------------------------------------------------- */

describe("the /mcp gate", () => {
  const rpc = (api: Api, authorization: string | null, body: object = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => {
    const call = api.post("/mcp").set("Accept", "application/json, text/event-stream");
    return (authorization ? call.set("Authorization", authorization) : call).send(body);
  };

  it("refuses a caller with no token, the wrong kind of credential, or a dead token, and says nothing about how to sign in", async () => {
    configure();
    const { api, db } = fixture();
    const none = await rpc(api, null).expect(401);
    assert.equal(none.headers["www-authenticate"], undefined, "Alexa+ does not support the WWW-Authenticate challenge");
    await rpc(api, `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`).expect(401);
    await rpc(api, "Bearer not-a-token").expect(401);
    await rpc(api, "Bearer ").expect(401);

    const { tokens } = await link(api);
    await rpc(api, `Bearer ${tokens.access_token}`).expect(200);
    db.prepare("UPDATE oauth_tokens SET access_expires_at=?").run(new Date(Date.now() - 1000).toISOString());
    const expired = await rpc(api, `Bearer ${tokens.access_token}`).expect(401);
    assert.equal(expired.headers["www-authenticate"], undefined);
  });

  it("answers GET and DELETE with 405 for a valid token and 401 for anyone else", async () => {
    configure();
    const { api } = fixture();
    await api.get("/mcp").expect(401);
    await api.delete("/mcp").expect(401);
    const { tokens } = await link(api);
    await api.get("/mcp").set("Authorization", `Bearer ${tokens.access_token}`).expect(405);
    await api.delete("/mcp").set("Authorization", `Bearer ${tokens.access_token}`).expect(405);
  });

  it("counts failures per caller and stops answering once there are too many", async () => {
    configure();
    const { api } = fixture();
    let last = 0;
    for (let attempt = 0; attempt < 32; attempt += 1) last = (await rpc(api, "Bearer guess")).status;
    assert.equal(last, 429);
  });

  it("keeps serving a valid token while bad ones from the same address are being refused", async () => {
    configure();
    const { api, app } = fixture();
    const { tokens } = await link(api);
    await withServer(app, async live => {
      // More than the 600-request cap, all refused: none of them may use up what a good token is allowed.
      for (let attempt = 0; attempt < 650; attempt += 1) await rpc(live, "Bearer guess");
      await rpc(live, `Bearer ${tokens.access_token}`).expect(200);
    });
  });

  it("opens only discovery, the token endpoint and /mcp, and a token opens nothing else", async () => {
    configure();
    const { api } = fixture();
    const { tokens } = await link(api);
    for (const path of ["/api/todos", "/api/integrations/alexa", "/api/memories", "/api/agent/context"]) {
      await api.get(path).expect(401);
      await api.get(path).set("Authorization", `Bearer ${tokens.access_token}`).expect(401);
    }
    await api.delete("/api/integrations/alexa/link").expect(401);
    await api.get("/oauth/authorize").query(authorizeQuery(pkce().challenge)).expect(302);
    await api.get("/api/health").expect(200);
  });

  it("serves the tools to a valid token, as JSON over a stateless transport", async () => {
    configure();
    const { api } = fixture();
    const { tokens } = await link(api);
    const list = await rpc(api, `Bearer ${tokens.access_token}`).expect(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map(tool => tool.name).sort();
    assert.deepEqual(names, [
      "add_todo_comment", "create_reminder", "create_todo", "get_agenda", "get_todo", "list_reminders", "list_todos", "set_todo_status",
    ]);
  });
});

/* The Household scope ---------------------------------------------------------------- */

describe("what an Echo can reach", () => {
  async function voice() {
    configure();
    const context = fixture();
    const { tokens } = await link(context.api);
    let id = 0;
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await context.api.post("/mcp").set("Authorization", `Bearer ${tokens.access_token}`)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }).expect(200);
      if (response.body.error) return { error: true as const, text: String(response.body.error.message), data: undefined };
      const result = response.body.result as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content[0]?.text ?? "";
      let data: Record<string, unknown> | undefined;
      try { data = JSON.parse(text) as Record<string, unknown>; } catch { data = undefined; }
      return { error: Boolean(result.isError), text, data };
    };
    return { ...context, tool };
  }

  it("keeps what Alexa makes in the Household area, with local times read in the owner's timezone", async () => {
    const { db, tool } = await voice();
    const made = await tool("create_todo", { title: "Buy milk", due: "2026-11-06T16:00", priority: "high" });
    assert.equal(made.error, false, made.text);
    const todo = (made.data as { todo: { id: string; due_at: string } }).todo;
    assert.equal(Date.parse(todo.due_at), Date.parse("2026-11-06T21:00:00Z"), "4pm New York in November is 21:00 UTC");
    const row = db.prepare(`
      SELECT t.life_area_id area, la.name name FROM todos t JOIN life_areas la ON la.id=t.life_area_id WHERE t.id=?
    `).get(todo.id) as { area: string; name: string };
    assert.equal(row.name, "Household");

    const duplicate = await tool("create_todo", { title: "Buy milk" });
    assert.equal(duplicate.error, true, "the same open task is refused, not added twice");
  });

  it("puts a reminder on the day it falls on in the owner's timezone, not on its UTC date", async () => {
    const { tool } = await voice();
    const made = await tool("create_todo", { title: "Call the plumber" });
    const id = (made.data as { todo: { id: string } }).todo.id;
    // 11pm in New York on the 6th is 04:00 UTC on the 7th.
    const reminder = await tool("create_reminder", { todo_id: id, remind_at: "2026-11-06T23:00" });
    assert.equal(reminder.error, false, reminder.text);
    assert.match((reminder.data as { reminder: { scheduled_for: string } }).reminder.scheduled_for, /^2026-11-07T04:00/);

    const days = async (date: string) => ((await tool("get_agenda", { start_date: date, end_date: date })).data as { reminders: unknown[] }).reminders.length;
    assert.equal(await days("2026-11-06"), 1, "it is on the 6th for the household");
    assert.equal(await days("2026-11-07"), 0, "and not on the 7th");
  });

  it("lists the older open tasks even when a long run of finished ones is newer", async () => {
    const { db, tool } = await voice();
    await tool("create_todo", { title: "Renew the car registration" });
    const done = await tool("create_todo", { title: "Done chore" });
    const finished = (done.data as { todo: { id: string } }).todo.id;
    assert.equal((await tool("set_todo_status", { id: finished, status: "done" })).error, false);
    const row = db.prepare("SELECT * FROM todos WHERE id=?").get(finished) as Record<string, unknown>;
    const columns = Object.keys(row);
    const insert = db.prepare(`INSERT INTO todos(${columns.join(",")}) VALUES(${columns.map(column => `@${column}`).join(",")})`);
    const later = Date.now() + 60_000;
    for (let index = 0; index < 205; index += 1) {
      insert.run({ ...row, id: `todo_filler_${index}`, created_at: new Date(later + index).toISOString() });
    }
    const listed = (await tool("list_todos")).data as { todos: Array<{ title: string }> };
    assert.deepEqual(listed.todos.map(todo => todo.title), ["Renew the car registration"], "205 newer finished tasks do not push it out");
    const all = (await tool("list_todos", { include_done: true, limit: 3 })).data as { todos: unknown[] };
    assert.equal(all.todos.length, 3);
  });

  it("cannot read or change the owner's own records", async () => {
    const { api, db, tool } = await voice();
    const { cookie } = { cookie: await signIn(api) };
    const own = (await api.post("/api/todos").set("Cookie", cookie).send({ title: "Call my therapist", notes: "Private" }).expect(201)).body.data as { id: string };
    await tool("create_todo", { title: "Take the bins out" });

    const listed = await tool("list_todos");
    const titles = (listed.data as { todos: Array<{ title: string }> }).todos.map(todo => todo.title);
    assert.deepEqual(titles, ["Take the bins out"]);
    assert.ok(!listed.text.includes("therapist"));

    for (const [name, args] of [
      ["get_todo", { id: own.id }],
      ["set_todo_status", { id: own.id, status: "done" }],
      ["add_todo_comment", { id: own.id, body: "hello" }],
      ["create_reminder", { todo_id: own.id, remind_at: "2030-01-01T09:00" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await tool(name, args);
      assert.equal(result.error, true, `${name} must not reach the owner's todo`);
      assert.ok(!result.text.includes("therapist") && !result.text.includes("Private"), `${name} must not echo it`);
    }
    const stored = db.prepare("SELECT status FROM todos WHERE id=?").get(own.id) as { status: string };
    assert.equal(stored.status, "pending");
    const agenda = await tool("get_agenda", { start_date: "2020-01-01", end_date: "2040-01-01" });
    assert.ok(!agenda.text.includes("therapist"));
  });

  it("offers no tool beyond the eight, and refuses the owner-only ones by name", async () => {
    const { tool } = await voice();
    for (const name of ["list_home_devices", "control_home_device", "web_search", "create_memory", "send_to_group", "delete_todo"]) {
      const result = await tool(name, {});
      assert.equal(result.error, true, `${name} must not be callable from an Echo`);
    }
  });

  it("answers well inside Alexa's half-second budget", async () => {
    const { tool } = await voice();
    await tool("create_todo", { title: "Warm up the server" });
    const started = performance.now();
    const listed = await tool("list_todos");
    const elapsed = performance.now() - started;
    assert.equal(listed.error, false);
    assert.ok(elapsed < 500, `list_todos took ${Math.round(elapsed)}ms`);
  });

  it("enforces the voice allow-list in the executor, not only in the MCP server", async () => {
    const { db } = fixture();
    const run = (name: string, input: Record<string, unknown>, context: ToolTurnContext) => executeAgentTool(db, { flushSoon() {} }, name, input, context);
    const stamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_hh',?,'web',?,'alg_cnv_hh',?,?)
    `).run(USER_ID, HOUSEHOLD_ADDRESS, stamp, stamp);
    const area = ensureGroupLifeArea(db, "thread_hh", "Household");
    const base: ToolTurnContext = {
      channel: "web", address: HOUSEHOLD_ADDRESS, threadId: "thread_hh", speakerIsOwner: false, surface: "voice",
    };
    await assert.rejects(run("list_todos", {}, base), /scoped to the Household/, "a voice turn with no scope is refused outright");
    const scoped = { ...base, scope: { lifeAreaId: area.id, threadId: "thread_hh" } };
    const valid: Array<[string, Record<string, unknown>]> = [
      ["web_search", { query: "weather", limit: null }],
      ["read_web_page", { url: "https://example.com/" }],
      ["list_home_devices", {}],
      ["home_device_status", { name: "Desk Lamp" }],
      ["control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: null }],
      ["run_alexa_routine", { name: "Good night" }],
      ["speak_on_echo", { text: "Hello", device: null }],
      ["send_to_contact", { name: "Sarah", text: "Hi" }],
    ];
    for (const [name, input] of valid) {
      await assert.rejects(run(name, input, scoped), /is not available by voice/, name);
    }
    assert.deepEqual(await run("list_todos", {}, scoped), []);
  });
});

/* The Household thread is not a group chat ------------------------------------------------ */

describe("the Household thread", () => {
  it("is recognised as a voice thread and is no group chat", async () => {
    configure();
    const { api, db, tool } = await (async () => {
      const context = fixture();
      const { tokens } = await link(context.api);
      const call = (name: string, args: Record<string, unknown>) => context.api.post("/mcp")
        .set("Authorization", `Bearer ${tokens.access_token}`).set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).expect(200);
      return { ...context, tool: call };
    })();
    await tool("create_todo", { title: "Water the plants" });
    const thread = db.prepare("SELECT id,address,channel FROM channel_threads WHERE address=?").get(HOUSEHOLD_ADDRESS) as { id: string; channel: string };
    assert.equal(thread.channel, "web");
    assert.ok(isVoiceThread(db, thread.id));
    assert.ok(!HOUSEHOLD_ADDRESS.startsWith("group:"), "no sender can text a thread whose address is not a group's");
    const groups = (await api.get("/api/life-areas").set("Cookie", await signIn(api)).expect(200)).body.data as Array<{ name: string }>;
    assert.ok(groups.some(area => area.name === "Household"));
  });

  it("is sent no check-in, no agent turn and no text of its own, and its reminders go to the owner", async () => {
    configure();
    const { db, search, api } = fixture();
    const { tokens } = await link(api);
    const call = (name: string, args: Record<string, unknown>) => api.post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`).set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).expect(200);
    const created = JSON.parse(((await call("create_todo", { title: "Feed the cat" })).body.result.content[0].text as string)) as { todo: { id: string } };
    const area = db.prepare("SELECT id FROM life_areas WHERE name='Household'").get() as { id: string };
    // iMessage is connected and both check-ins are due, which is what would send a real group its note.
    saveSendblueConfig(db, {
      apiKeyId: "sendblue-key-id", apiSecret: "sendblue-api-secret", fromPhone: "+15551234567",
      webhookBaseUrl: BASE, webhookSecret: "secret",
    }, { webhooksRegistered: true, autoTypingIndicator: true, autoMarkRead: true });
    setSmsProvider(db, "sendblue");
    const slot = localParts(new Date(), "America/New_York").time;
    db.prepare("UPDATE life_areas SET morning_checkin_time=?, evening_checkin_time=?, checkin_copy_to_owner=1 WHERE id=?").run(slot, slot, area.id);
    // A reminder that is already due. It is filed under the Household thread, whose address is not a group's, so it falls back to the owner.
    const filed = db.prepare("SELECT t.reply_thread_id thread, ct.address address FROM todos t LEFT JOIN channel_threads ct ON ct.id=t.reply_thread_id WHERE t.id=?")
      .get(created.todo.id) as { thread: string | null; address: string | null };
    assert.equal(filed.address, HOUSEHOLD_ADDRESS, "the reminder is tied to the Household thread, which is what must not be texted");
    const stamp = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE todos SET reminder_at=? WHERE id=?").run(stamp, created.todo.id);
    db.prepare(`
      INSERT INTO reminders(id,todo_id,user_id,kind,scheduled_for,status,created_at,updated_at)
      VALUES('reminder_hh',?,?,'pre',?,'pending',?,?)
    `).run(created.todo.id, USER_ID, stamp, stamp, stamp);

    const sent: Array<{ to: string; body: string }> = [];
    const agentThreads: string[] = [];
    await runWorkerOnce(db, search, {
      sendSms: async (_db, to, body) => { sent.push({ to, body }); return { sid: `SM_${sent.length}`, status: "queued" }; },
      runSmsAgent: async (_db, _search, address) => { agentThreads.push(String(address)); return { text: "hi", threadId: "unused" }; },
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });
    assert.ok(sent.length >= 1, "the due reminder is texted");
    assert.ok(sent.every(message => message.to === OWNER), `every text goes to the owner's own number, got ${JSON.stringify(sent.map(message => message.to))}`);
    assert.ok(sent.some(message => message.body.includes("Feed the cat")));
    assert.ok(!agentThreads.some(address => address.includes("alexa")), "no agent turn is run on the Household thread");
    assert.ok(!sent.some(message => /good morning|how did the day go/i.test(message.body)), "no check-in is texted for it");
  });
});

/* Fieldnote controlling Alexa ----------------------------------------------------------------- */

class FakeAlexa implements AlexaToolClient {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  failWith: string | null = null;
  hang = false;

  async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    this.calls.push({ tool, args });
    if (this.hang) throw new (await import("../server/alexa-control.ts")).AlexaServiceError("Alexa did not respond within 20s", { timedOut: true });
    if (this.failWith) return { text: this.failWith, isError: true };
    const json = (value: unknown) => ({ text: JSON.stringify(value), isError: false });
    switch (tool) {
      case "alexa_list_devices": return json([
        { accountName: "Kitchen Echo", deviceType: "ECHO", online: true }, { accountName: "Bedroom Echo", deviceType: "ECHO", online: true },
      ]);
      case "alexa_list_appliances": return json([
        { friendlyName: "Desk Lamp", applianceTypes: ["LIGHT"], isReachable: true },
        { friendlyName: "Reading Light", applianceTypes: ["LIGHT"] },
        { friendlyName: "Reading Lamp", applianceTypes: ["LIGHT"] },
        { friendlyName: "Front Door Lock", applianceTypes: ["SMARTLOCK"] },
        { friendlyName: "Hallway", applianceTypes: ["SMARTLOCK"] },
        { friendlyName: "Porch", applianceTypes: ["CAMERA"] },
      ]);
      case "alexa_list_device_groups": return json([{ name: "Living Room", applianceCount: 2 }, { name: "Entry", applianceCount: 2 }]);
      case "alexa_group_members": return json({
        members: args.groupName === "Entry"
          ? [{ friendlyName: "Entry Light", applianceTypes: ["LIGHT"] }, { friendlyName: "Front Door Lock", applianceTypes: ["SMARTLOCK"] }]
          : [{ friendlyName: "Desk Lamp", applianceTypes: ["LIGHT"] }],
      });
      case "alexa_control_by_group": return json({ success: true, partial: false, controlled: ["Desk Lamp"], errors: [] });
      case "alexa_list_routines": return json([{ automationId: "A1", name: "Good night" }, { automationId: "A2", name: "Unlock the doors" }]);
      case "alexa_device_status": return json({ name: args.name, on: true });
      case "alexa_auth_status": return json({ configured: true, valid: true, deviceCount: 6 });
      default: return { text: "Done.", isError: false };
    }
  }

  async close(): Promise<void> {}
}

describe("Fieldnote operating the owner's Alexa devices", () => {
  function home() {
    const alexa = new FakeAlexa();
    process.env.ALEXA_REFRESH_TOKEN = "test-refresh-token";
    // Any file that exists stands in for the server's entry point; the fake client means it is never started.
    process.env.ALEXA_MCP_PATH = import.meta.filename;
    setAlexaClient(alexa);
    resetAlexaState();
    return { alexa, ...fixture() };
  }

  const tool = (api: Api, name: string, input: object = {}, expected = 200) =>
    api.post(`/api/agent/tools/${name}`).send(input).expect(expected).then(response => response.body);
  const OPERATING = ["alexa_switch_by_name", "alexa_set_brightness_by_name", "alexa_control_by_group", "alexa_run_routine", "alexa_announce", "alexa_speak"];

  it("lists devices, rooms and Echos, and marks what Fieldnote will not operate", async () => {
    const { api, alexa } = home();
    const listed = (await tool(api, "list_home_devices")).data;
    assert.deepEqual(listed.echo_devices.map((device: { name: string }) => device.name), ["Kitchen Echo", "Bedroom Echo"]);
    assert.deepEqual(listed.rooms.map((room: { name: string }) => room.name), ["Living Room", "Entry"]);
    const operable = Object.fromEntries(listed.smart_home_devices.map((device: { name: string; operable: boolean }) => [device.name, device.operable]));
    assert.equal(operable["Desk Lamp"], true);
    assert.equal(operable["Front Door Lock"], false);
    assert.equal(operable["Hallway"], false, "a lock called something harmless is still a lock, by its type");
    assert.equal(operable["Porch"], false);
    assert.ok(!alexa.calls.some(call => OPERATING.includes(call.tool)), "reading changes nothing");
  });

  it("switches one device or a room's lights, resolving the name before it acts", async () => {
    const { api, alexa } = home();
    const one = (await tool(api, "control_home_device", { target: "desk", target_kind: "device", action: "off", brightness: null })).data;
    assert.deepEqual(one, { source: "alexa", done: true, device: "Desk Lamp", state: "off" });
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_switch_by_name", args: { name: "Desk Lamp", state: "off" } }, "the resolved name is what is operated, never the spoken one");

    const dim = (await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: null, brightness: 40 })).data;
    assert.equal(dim.brightness, 40);
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_set_brightness_by_name", args: { name: "Desk Lamp", brightness: 40 } });

    const room = (await tool(api, "control_home_device", { target: "living", target_kind: "group", action: "on", brightness: null })).data;
    assert.equal(room.group, "Living Room");
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_control_by_group", args: { groupName: "Living Room", state: "on", lightsOnly: true } });

    await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: null, brightness: null }, 400);
    await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: 50 }, 400);
    await tool(api, "control_home_device", { target: "Living Room", target_kind: "group", action: null, brightness: 50 }, 400);
    await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: "dim", brightness: null }, 400);
    await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: null, extra: 1 }, 400);
  });

  it("asks which one when a name fits several, and says so when it fits none", async () => {
    const { api, alexa } = home();
    const several = await tool(api, "control_home_device", { target: "reading", target_kind: "device", action: "on", brightness: null }, 400);
    assert.match(several.error, /More than one device matches "reading" \(Reading Light, Reading Lamp\)/);
    const none = await tool(api, "home_device_status", { name: "toaster" }, 400);
    assert.match(none.error, /No smart home device is called "toaster"/);
    assert.ok(!alexa.calls.some(call => OPERATING.includes(call.tool)));
  });

  it("never operates a lock, door, garage, camera or alarm, by name or by type", async () => {
    const { api, alexa } = home();
    for (const target of ["Front Door Lock", "front door", "Hallway", "Porch"]) {
      const refused = await tool(api, "control_home_device", { target, target_kind: "device", action: "off", brightness: null }, 403);
      assert.match(refused.error, /^Alexa refused: .*does not operate/, target);
    }
    await tool(api, "home_device_status", { name: "Front Door Lock" }, 403);
    // One lock in a room keeps the whole room from being switched.
    await tool(api, "control_home_device", { target: "Entry", target_kind: "group", action: "off", brightness: null }, 403);
    // Even a routine the owner listed is refused when its name says it locks or unlocks something.
    process.env.ALEXA_ALLOWED_ROUTINES = "Good night, Unlock the doors";
    await tool(api, "run_alexa_routine", { name: "Unlock the doors" }, 403);
    assert.ok(!alexa.calls.some(call => OPERATING.includes(call.tool)), `nothing was operated, got ${JSON.stringify(alexa.calls.map(call => call.tool))}`);
  });

  it("runs only the routines the owner has listed, because a routine's steps cannot be read first", async () => {
    const { api, alexa } = home();
    // A harmless name proves nothing: "Good night" could unlock a door, and the server shows only its name.
    const none = await tool(api, "run_alexa_routine", { name: "Good night" }, 403);
    assert.match(none.error, /^Alexa refused: .*ALEXA_ALLOWED_ROUTINES/);
    assert.ok(!alexa.calls.some(call => call.tool === "alexa_list_routines" || OPERATING.includes(call.tool)), "refused before Alexa was asked anything");

    process.env.ALEXA_ALLOWED_ROUTINES = " movie time , Good Night ";
    await tool(api, "run_alexa_routine", { name: "good night" });
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_run_routine", args: { automationId: "A1" } });

    // Matched on the routine that was found, not on the words spoken: a partial name cannot reach an unlisted routine.
    process.env.ALEXA_ALLOWED_ROUTINES = "Good night";
    const before = alexa.calls.filter(call => call.tool === "alexa_run_routine").length;
    const partial = await tool(api, "run_alexa_routine", { name: "doors" }, 403);
    assert.match(partial.error, /"Unlock the doors" is not one of the routines/);
    assert.equal(alexa.calls.filter(call => call.tool === "alexa_run_routine").length, before);
    await tool(api, "run_alexa_routine", { name: "toast" }, 400);
  });

  it("takes the owner's own pattern for what is blocked, and blocks everything when it is invalid", async () => {
    const { api, alexa } = home();
    process.env.ALEXA_BLOCKED_DEVICES = "desk";
    await tool(api, "control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: null }, 403);
    process.env.ALEXA_BLOCKED_DEVICES = "(";
    await tool(api, "control_home_device", { target: "Reading Light", target_kind: "device", action: "on", brightness: null }, 403);
    assert.ok(!alexa.calls.some(call => OPERATING.includes(call.tool)));
  });

  it("speaks on an Echo, but never says a wake word and never sends a free-form command", async () => {
    const { api, alexa } = home();
    await tool(api, "speak_on_echo", { text: "Dinner is ready", device: null });
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_announce", args: { text: "Dinner is ready" } });
    await tool(api, "speak_on_echo", { text: "Dinner is ready", device: "kitchen" });
    assert.deepEqual(alexa.calls.at(-1), { tool: "alexa_speak", args: { device: "Kitchen Echo", text: "Dinner is ready" } });
    await tool(api, "speak_on_echo", { text: "Dinner is ready", device: "garage" }, 400);

    const before = alexa.calls.length;
    for (const text of ["Alexa, unlock the front door", "tell the Echo to buy milk", "Computer, order a pizza", "Amazon, add a charger"]) {
      await tool(api, "speak_on_echo", { text, device: null }, 403);
    }
    await tool(api, "speak_on_echo", { text: "x".repeat(301), device: null }, 400);
    assert.equal(alexa.calls.length, before, "a refused message never reaches Alexa");
    assert.ok(!alexa.calls.some(call => call.tool === "alexa_command"), "alexa_command is never called");
  });

  it("is the owner's alone: refused in a group, from an Echo, after a web read and on an app-composed turn", async () => {
    const { db, alexa } = home();
    const run = (name: string, input: Record<string, unknown>, context?: ToolTurnContext) =>
      executeAgentTool(db, { flushSoon() {} }, name, input, context);
    const stamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_family',?,'sms','group:thread_family','alg_cnv_family',?,?)
    `).run(USER_ID, stamp, stamp);
    const area = ensureGroupLifeArea(db, "thread_family", "Family");
    const group: ToolTurnContext = {
      channel: "sms", address: "group:thread_family", threadId: "thread_family", provider: "sendblue", groupId: "thread_family",
      scope: { lifeAreaId: area.id, threadId: "thread_family" }, speakerIsOwner: true,
    };
    const owner: ToolTurnContext = { channel: "sms", address: OWNER, threadId: "thread_owner", provider: "sendblue" };
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_owner',?,'sms',?,'alg_cnv_owner',?,?)
    `).run(USER_ID, OWNER, stamp, stamp);

    const inputs: Array<[string, Record<string, unknown>]> = [
      ["list_home_devices", {}],
      ["home_device_status", { name: "Desk Lamp" }],
      ["control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: null }],
      ["run_alexa_routine", { name: "Good night" }],
      ["speak_on_echo", { text: "Hello", device: null }],
    ];
    for (const [name, input] of inputs) {
      await assert.rejects(run(name, input, group), /not available in a group chat/, `${name} in a group, even the owner speaking`);
      await assert.rejects(run(name, input, { ...owner, scope: group.scope, surface: "voice" }), /not available by voice/, `${name} by voice`);
      await assert.rejects(run(name, input, { ...owner, readWeb: true }), /read text someone else wrote/, `${name} after a web read`);
      await assert.rejects(run(name, input, { ...owner, readUntrusted: true }), /read text someone else wrote/, `${name} after outside text`);
      await assert.rejects(run(name, input, { ...owner, appTurn: "daily_digest" }), /app writing/, `${name} on an app turn`);
    }
    assert.equal(alexa.calls.length, 0, "none of those reached Alexa");

    const allowed = await run("control_home_device", { target: "Desk Lamp", target_kind: "device", action: "on", brightness: null }, owner) as { done: boolean };
    assert.equal(allowed.done, true, "the owner's own turn is let through");
  });

  it("is unavailable until configured, and does not count calls it never made", async () => {
    const { api } = home();
    process.env.ALEXA_MCP_PATH = "/nonexistent/alexa-mcp.js";
    process.env.ALEXA_DAILY_LIMIT = "1";
    assert.match((await tool(api, "list_home_devices", {}, 503)).error, /Alexa control is not configured/);
    assert.match((await tool(api, "list_home_devices", {}, 503)).error, /not configured/, "the allowance was not spent on a call that could not be made");
    process.env.ALEXA_MCP_PATH = import.meta.filename;
    await tool(api, "list_home_devices");
  });

  it("stops at the day's allowance, giving a refusal's call back but not a timeout's", async () => {
    const { api, alexa } = home();
    process.env.ALEXA_DAILY_LIMIT = "2";
    await tool(api, "control_home_device", { target: "Front Door Lock", target_kind: "device", action: "off", brightness: null }, 403);
    await tool(api, "control_home_device", { target: "Porch", target_kind: "device", action: "off", brightness: null }, 403);
    await tool(api, "list_home_devices");
    await tool(api, "list_home_devices");
    const over = await tool(api, "list_home_devices", {}, 429);
    assert.match(over.error, /limit of 2 calls for today/);

    resetAlexaState();
    alexa.hang = true;
    await tool(api, "list_home_devices", {}, 502);
    await tool(api, "list_home_devices", {}, 502);
    alexa.hang = false;
    await tool(api, "list_home_devices", {}, 429);

    process.env.ALEXA_DAILY_LIMIT = "0";
    assert.match((await tool(api, "list_home_devices", {}, 503)).error, /turned off/);
  });

  it("holds the deadline while the child is still starting, and lets go of it", async () => {
    const stalled = join(mkdtempSync(join(tmpdir(), "alexa-stall-")), "never-answers.mjs");
    writeFileSync(stalled, "setInterval(() => {}, 1000);\n");
    const { api } = home();
    setAlexaClient();
    process.env.ALEXA_MCP_PATH = stalled;
    process.env.ALEXA_TIMEOUT_MS = "400";
    const started = Date.now();
    const failed = await tool(api, "list_home_devices", {}, 502);
    assert.match(failed.error, /did not respond within 0\.4s/);
    assert.ok(Date.now() - started < 5000, "bounded by the configured deadline, not by the protocol's own 60s");
    await closeAlexaControl();
  });

  it("reports an Alexa failure as an upstream fault with its own wording", async () => {
    const { api, alexa } = home();
    alexa.failWith = "Amazon said no";
    const failed = await tool(api, "list_home_devices", {}, 502);
    assert.match(failed.error, /^Alexa alexa_list_devices failed: Amazon said no/);
  });

  it("shows its status in Settings", async () => {
    const { api } = home();
    const status = (await api.get("/api/integrations/alexa").expect(200)).body.data;
    assert.deepEqual(status.control, { configured: true, valid: true, deviceCount: 6 });
  });
});
