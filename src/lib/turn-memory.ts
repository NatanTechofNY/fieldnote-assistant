import type { AgentTurnMemory } from "../types";

/** The turn context caps each value, so the facts are cut from the tail until they fit. */
const maxSerializedLength = 3500;

/**
 * The owner's Soul and their relevant memories as flat string values, the only
 * shape the Agent Studio turn context accepts. Absent keys rather than empty
 * ones, so the agent is not left reasoning about a blank.
 */
export function serializeTurnMemory(memory: AgentTurnMemory): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof memory.soul === "string" && memory.soul) out.soul = memory.soul;
  // Read at send time, so an odd answer from the server must not stop the message going out.
  const ownerFacts = Array.isArray(memory.ownerFacts) ? memory.ownerFacts : [];
  let facts = ownerFacts.map(fact => fact.title ? `${fact.title}: ${fact.content}` : fact.content);
  while (facts.length && JSON.stringify(facts).length > maxSerializedLength) facts = facts.slice(0, -1);
  if (facts.length) out.ownerFacts = JSON.stringify(facts);
  return out;
}
