import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { localParts } from "./local-time.ts";

/*
 * Control of the owner's Echo devices and smart home, through the community
 * `alexa-mcp` server. Amazon offers no supported API for this: that server
 * drives Alexa's private one with a refresh token, so any of it can stop
 * working whenever Amazon changes something, and none of it is a place to
 * trust more than it has to be.
 *
 * Fieldnote is the MCP client here, over stdio to a child process it starts
 * itself, for the same reason web search is (see `web-service.ts`): added to
 * Agent Studio as an MCP tool it would run outside the executor, with none of
 * the checks below. It exposes five tools of its own, not the server's
 * twenty-five. In particular `alexa_command` is never called: a free-form
 * voice command can buy things and unlock doors.
 *
 * The child never touches SQLite, so the single-writer rule is unaffected.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DAILY_LIMIT = 100;
const MAX_SPEECH_CHARS = 300;

/**
 * Words that wake an Echo. One speaker saying them makes the next Echo along
 * act on what follows, so Fieldnote never has a device say them: `speak_on_echo`
 * is not a way to give Alexa an order.
 */
const WAKE_WORDS = /\b(?:alexa|echo|computer|amazon|ziggy)\b/i;

/** The default for `ALEXA_BLOCKED_DEVICES`: what is never operated from here, whatever it is called. */
export const DEFAULT_BLOCKED_DEVICES = "\\b(?:un)?lock|padlock|deadbolt|garage|door|alarm|security|camera";
/** Alexa's own device types for the same things, checked whatever the owner named them. */
const BLOCKED_TYPES = /LOCK|CAMERA|SECURITY|GARAGE|DOOR|ALARM|SIREN/i;

/** A refusal Fieldnote's own policy made, as opposed to a failure of Alexa; it does not use up the day's allowance. */
export class AlexaRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlexaRefusal";
  }
}

/** Every failure talking to Alexa. The message is ready for the model; `timedOut` marks a call that may still have run. */
export class AlexaServiceError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, options: { cause?: unknown; timedOut?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = "AlexaServiceError";
    this.timedOut = options.timedOut ?? false;
  }
}

/* The child process -------------------------------------------------------- */

/** What one tool call to the server returns, and the only surface the rest of this file (and the tests) depend on. */
export interface AlexaToolClient {
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

function modulePath(): string {
  return process.env.ALEXA_MCP_PATH?.trim() || resolve("node_modules/alexa-mcp/dist/index.js");
}

/** The saved login `alexa-mcp auth` leaves behind; with it, no token needs to be in `.env`. */
function savedLoginExists(): boolean {
  return existsSync(join(homedir(), ".alexa-mcp", "config.json"));
}

/** Checked before a call is counted, so an unconfigured app spends none of the day's allowance. */
export function alexaConfig(): { refreshToken: string | null; domain: string } {
  const refreshToken = process.env.ALEXA_REFRESH_TOKEN?.trim() || null;
  if ((!refreshToken && !savedLoginExists()) || !existsSync(modulePath())) throw new Error("Alexa control is not configured");
  return { refreshToken, domain: process.env.ALEXA_DOMAIN?.trim() || "amazon.com" };
}

class StdioAlexaClient implements AlexaToolClient {
  private connected: Promise<Client> | undefined;

  private connect(): Promise<Client> {
    if (this.connected) return this.connected;
    const { refreshToken, domain } = alexaConfig();
    const client = new Client({ name: "fieldnote", version: "1.0.0" });
    // The transport adds only a short list of safe variables (PATH, HOME) to these; nothing else of ours reaches the child.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [modulePath()],
      env: { ...(refreshToken ? { ALEXA_REFRESH_TOKEN: refreshToken } : {}), ALEXA_DOMAIN: domain },
      stderr: "ignore",
    });
    transport.onclose = () => {
      // The next call starts a fresh child rather than writing to a dead one.
      this.connected = undefined;
    };
    const pending = client.connect(transport).then(() => client);
    this.connected = pending;
    pending.catch(() => {
      if (this.connected === pending) this.connected = undefined;
    });
    return pending;
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const client = await this.connect();
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal: deadline, timeout: timeoutMs });
      let text = "";
      for (const part of Array.isArray(result.content) ? result.content : []) {
        if (part?.type === "text" && typeof part.text === "string") text += (text ? "\n" : "") + part.text;
      }
      return { text, isError: Boolean(result.isError) };
    } catch (error) {
      if (deadline.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) {
        // A call that hung may have wedged the child: drop it, and the next call starts another.
        await this.close();
        throw new AlexaServiceError(`Alexa did not respond within ${timeoutMs / 1000}s (${tool})`, { cause: error, timedOut: true });
      }
      throw new AlexaServiceError(`Alexa ${tool} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, { cause: error });
    }
  }

  async close(): Promise<void> {
    const pending = this.connected;
    this.connected = undefined;
    if (pending) await (await pending.catch(() => undefined))?.close().catch(() => undefined);
  }
}

let alexaClient: AlexaToolClient | undefined;

function client(): AlexaToolClient {
  alexaClient ??= new StdioAlexaClient();
  return alexaClient;
}

/** Tests stand in for the child process; passing nothing puts the real one back. */
export function setAlexaClient(replacement?: AlexaToolClient): void {
  void alexaClient?.close();
  alexaClient = replacement;
}

/** Stops the child; called on shutdown and between tests. */
export async function closeAlexaControl(): Promise<void> {
  await alexaClient?.close();
  alexaClient = undefined;
}

function timeoutMs(): number {
  const value = Number(process.env.ALEXA_TIMEOUT_MS?.trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** One call to the server whose answer is JSON; a tool error becomes an `Alexa …` failure. */
async function ask<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const { text, isError } = await client().call(tool, args, timeoutMs());
  if (isError) throw new AlexaServiceError(`Alexa ${tool} failed: ${text.slice(0, 300) || "no detail"}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AlexaServiceError(`Alexa ${tool} returned something unreadable`);
  }
}

/** One call whose answer is a sentence, not data. */
async function act(tool: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await client().call(tool, args, timeoutMs());
  if (isError) throw new AlexaServiceError(`Alexa ${tool} failed: ${text.slice(0, 300) || "no detail"}`);
  return text;
}

/* The day's allowance -------------------------------------------------------- */

let usage = { day: "", calls: 0 };

/**
 * Counts one call and returns how to give it back. Alexa has no bill, but a
 * runaway loop of "turn the light off, turn it on" is worth stopping, so a day
 * has a ceiling like web lookups do. A refusal by policy is given back; a
 * timeout keeps its place, since the device may have acted.
 */
export function takeAlexaCall(timezone: string): () => void {
  const raw = process.env.ALEXA_DAILY_LIMIT?.trim();
  const parsed = raw ? Number(raw) : NaN;
  const limit = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_DAILY_LIMIT;
  if (limit === 0) throw new Error("Alexa control is turned off");
  const day = localParts(new Date(), timezone).date;
  if (usage.day !== day) usage = { day, calls: 0 };
  if (usage.calls >= limit) throw new Error(`Alexa control has reached its limit of ${limit} calls for today`);
  usage.calls += 1;
  const counted = usage;
  let released = false;
  return () => {
    if (released || usage !== counted) return;
    released = true;
    usage.calls -= 1;
  };
}

/** Clears the day's count; tests start from nothing. */
export function resetAlexaState(): void {
  usage = { day: "", calls: 0 };
}

/* What may be operated -------------------------------------------------------- */

/** The owner's pattern for what is never operated from here; an invalid one blocks everything rather than nothing. */
function blockedPattern(): RegExp {
  const configured = process.env.ALEXA_BLOCKED_DEVICES?.trim();
  try {
    return new RegExp(configured || DEFAULT_BLOCKED_DEVICES, "i");
  } catch {
    throw new AlexaRefusal("ALEXA_BLOCKED_DEVICES is not a valid pattern, so no device can be operated until it is fixed");
  }
}

/** Throws when a device or routine is one Fieldnote does not operate. */
export function assertOperable(name: string, types: string[] = []): void {
  if (blockedPattern().test(name) || types.some(type => BLOCKED_TYPES.test(type))) {
    throw new AlexaRefusal(`"${name}" is a lock, door, camera or alarm, which Fieldnote does not operate; use the Alexa app for it`);
  }
}

type Appliance = { friendlyName: string; isReachable?: boolean; applianceTypes?: string[]; capabilities?: string[] };
type Device = { accountName: string; deviceType?: string; online?: boolean };
type Group = { name: string; applianceCount?: number };
type Routine = { automationId: string; name: string };

/**
 * The one appliance a spoken name means: exact, then starting with it, then
 * containing it, ignoring case. Resolved here rather than by the server so
 * that the device the policy checks is the device that is operated.
 */
function resolveAppliance(appliances: Appliance[], wanted: string): Appliance {
  const query = wanted.trim().toLowerCase();
  const by = (test: (name: string) => boolean) => appliances.filter(appliance => test(appliance.friendlyName.toLowerCase()));
  const tiers = [by(name => name === query), by(name => name.startsWith(query)), by(name => name.includes(query))];
  const found = tiers.find(tier => tier.length > 0) ?? [];
  if (!found.length) throw new Error(`No smart home device is called "${wanted}"; use list_home_devices for the names`);
  if (found.length > 1) {
    throw new Error(`More than one device matches "${wanted}" (${found.slice(0, 6).map(device => device.friendlyName).join(", ")}); ask which one`);
  }
  return found[0];
}

/* The tools --------------------------------------------------------------------- */

export async function listHomeDevices(): Promise<Record<string, unknown>> {
  const [devices, appliances, groups] = await Promise.all([
    ask<Device[]>("alexa_list_devices"),
    ask<Appliance[]>("alexa_list_appliances"),
    ask<Group[]>("alexa_list_device_groups"),
  ]);
  return {
    echo_devices: devices.map(device => ({ name: device.accountName, type: device.deviceType ?? null, online: device.online ?? null })),
    smart_home_devices: appliances.map(appliance => ({
      name: appliance.friendlyName,
      reachable: appliance.isReachable ?? null,
      // What a device is called is not always what it does; a name the owner chose for a lock is still a lock.
      operable: !isBlocked(appliance.friendlyName, appliance.applianceTypes),
    })),
    rooms: groups.map(group => ({ name: group.name, devices: group.applianceCount ?? null })),
  };
}

function isBlocked(name: string, types?: string[]): boolean {
  try {
    assertOperable(name, types);
    return false;
  } catch {
    return true;
  }
}

export async function homeDeviceStatus(name: string): Promise<Record<string, unknown>> {
  const appliance = resolveAppliance(await ask<Appliance[]>("alexa_list_appliances"), name);
  // Reading a lock's state is harmless, but Fieldnote does not report on doors and cameras either.
  assertOperable(appliance.friendlyName, appliance.applianceTypes);
  return ask("alexa_device_status", { name: appliance.friendlyName });
}

export async function controlHomeDevice(input: {
  target: string;
  target_kind: "device" | "group";
  action?: "on" | "off" | null;
  brightness?: number | null;
}): Promise<Record<string, unknown>> {
  const brightness = typeof input.brightness === "number" ? input.brightness : null;
  if (!input.action && brightness === null) throw new Error("Pass action \"on\" or \"off\", or a brightness from 0 to 100");
  if (input.action && brightness !== null) throw new Error("Pass either action or brightness, not both");
  if (brightness !== null) {
    if (input.target_kind !== "device") throw new Error("Brightness is set on one device at a time; pass target_kind \"device\"");
    const appliance = resolveAppliance(await ask<Appliance[]>("alexa_list_appliances"), input.target);
    assertOperable(appliance.friendlyName, appliance.applianceTypes);
    await act("alexa_set_brightness_by_name", { name: appliance.friendlyName, brightness });
    return { done: true, device: appliance.friendlyName, brightness };
  }
  const action = input.action as "on" | "off";
  if (input.target_kind === "device") {
    const appliance = resolveAppliance(await ask<Appliance[]>("alexa_list_appliances"), input.target);
    assertOperable(appliance.friendlyName, appliance.applianceTypes);
    // No `device` argument is ever passed: that is the server's voice-command fallback, which this does not use.
    await act("alexa_switch_by_name", { name: appliance.friendlyName, state: action });
    return { done: true, device: appliance.friendlyName, state: action };
  }
  // A group is every light in a room. Its members are named first, so one blocked device keeps the whole room from being touched.
  const groups = await ask<Group[]>("alexa_list_device_groups");
  const wanted = input.target.trim().toLowerCase();
  const exactRooms = groups.filter(group => group.name.toLowerCase() === wanted);
  const rooms = exactRooms.length ? exactRooms : groups.filter(group => group.name.toLowerCase().includes(wanted));
  if (!rooms.length) throw new Error(`No group is called "${input.target}"; use list_home_devices for the names`);
  if (rooms.length > 1) throw new Error(`More than one group matches "${input.target}" (${rooms.map(group => group.name).join(", ")}); ask which one`);
  const members = await ask<{ members: Appliance[] }>("alexa_group_members", { groupName: rooms[0].name });
  for (const member of members.members) assertOperable(member.friendlyName, member.applianceTypes);
  const result = await ask<{ controlled: string[]; errors: string[]; success: boolean; partial: boolean }>("alexa_control_by_group", {
    groupName: rooms[0].name, state: action, lightsOnly: true,
  });
  return { done: result.success || result.partial, group: rooms[0].name, state: action, controlled: result.controlled, errors: result.errors };
}

export async function runAlexaRoutine(name: string): Promise<Record<string, unknown>> {
  const routines = await ask<Routine[]>("alexa_list_routines");
  const query = name.trim().toLowerCase();
  const exact = routines.filter(routine => routine.name.toLowerCase() === query);
  const found = exact.length ? exact : routines.filter(routine => routine.name.toLowerCase().includes(query));
  if (!found.length) throw new Error(`No routine is called "${name}"`);
  if (found.length > 1) throw new Error(`More than one routine matches "${name}" (${found.slice(0, 6).map(routine => routine.name).join(", ")}); ask which one`);
  // A routine is whatever the owner built, and it can do anything a voice command can: named like a lock, it is not run.
  assertOperable(found[0].name);
  await act("alexa_run_routine", { automationId: found[0].automationId });
  return { done: true, routine: found[0].name };
}

export async function speakOnEcho(input: { text: string; device?: string | null }): Promise<Record<string, unknown>> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("There is nothing to say");
  if (text.length > MAX_SPEECH_CHARS) throw new Error(`Keep it to ${MAX_SPEECH_CHARS} characters`);
  if (WAKE_WORDS.test(text)) {
    throw new AlexaRefusal("Fieldnote does not say an Echo's wake word aloud: a speaker saying it makes the next Echo act on what follows");
  }
  if (!input.device) {
    await act("alexa_announce", { text });
    return { done: true, said: text, where: "all Echo devices" };
  }
  const devices = await ask<Device[]>("alexa_list_devices");
  const wanted = input.device.trim().toLowerCase();
  const found = devices.filter(device => device.accountName.toLowerCase() === wanted);
  const matches = found.length ? found : devices.filter(device => device.accountName.toLowerCase().includes(wanted));
  if (!matches.length) throw new Error(`No Echo is called "${input.device}"; use list_home_devices for the names`);
  if (matches.length > 1) throw new Error(`More than one Echo matches "${input.device}" (${matches.map(device => device.accountName).join(", ")}); ask which one`);
  await act("alexa_speak", { device: matches[0].accountName, text });
  return { done: true, said: text, where: matches[0].accountName };
}

/** Whether the child answers: the status Settings shows. Never throws. */
export async function alexaStatus(): Promise<{ configured: boolean; valid?: boolean; deviceCount?: number; error?: string }> {
  try {
    alexaConfig();
  } catch {
    return { configured: false };
  }
  try {
    const status = await ask<{ configured: boolean; valid?: boolean; deviceCount?: number }>("alexa_auth_status");
    return { configured: true, valid: status.valid ?? false, ...(status.deviceCount !== undefined ? { deviceCount: status.deviceCount } : {}) };
  } catch (error) {
    return { configured: true, valid: false, error: error instanceof Error ? error.message : "Alexa did not answer" };
  }
}
