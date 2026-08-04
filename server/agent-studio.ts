import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type AgentTool = Record<string, unknown> & {
  type?: string;
  name?: string;
};

type SearchIndexEntry = Record<string, unknown> & { index: string };
type SearchToolSource = { type: string; name: string; indices: SearchIndexEntry[] };

type AgentResponse = {
  tools?: AgentTool[];
};

export type AgentStudioSyncResult = {
  agentId: string;
  clientTools: number;
  preservedTools: number;
  searchIndices: number;
  published: true;
};

export type AgentStudioSyncOptions = {
  applicationId?: string;
  apiKey?: string;
  agentId?: string;
  fetcher?: typeof fetch;
  toolsPath?: string;
  promptPath?: string;
  searchToolPath?: string;
  systemPromptPath?: string;
};

/**
 * The checked-in tool names the demo defaults, so an environment that renames an
 * index does not end up with a search tool pointed at one that does not exist.
 */
const INDEX_ENV_OVERRIDES: Record<string, string> = {
  devcon_assistant_todos: "ALGOLIA_TODO_INDEX",
  devcon_assistant_memories: "ALGOLIA_MEMORY_INDEX",
  devcon_assistant_messages: "ALGOLIA_MESSAGE_INDEX",
};

const resolveIndexName = (name: string): string =>
  process.env[INDEX_ENV_OVERRIDES[name] ?? ""] || name;

/**
 * Rebuilds the Algolia Search tool from the checked-in file. Algolia derives
 * `enhancedDescription` from the records themselves, so anything the file does
 * not own is carried over from the live entry for the same index instead of
 * being dropped.
 */
function buildSearchTool(source: SearchToolSource, current: AgentTool | undefined): AgentTool {
  const existing = new Map(
    ((current?.indices as SearchIndexEntry[] | undefined) || []).map(entry => [entry.index, entry]),
  );
  return {
    ...current,
    type: source.type,
    name: source.name,
    indices: source.indices.map((entry) => {
      const index = resolveIndexName(entry.index);
      return { ...existing.get(index), ...entry, index };
    }),
  };
}

const responseError = async (response: Response, action: string): Promise<Error> => {
  const body = (await response.text()).slice(0, 500);
  return new Error(`${action} failed (${response.status}): ${body || response.statusText}`);
};

export async function syncAgentStudioTools(
  options: AgentStudioSyncOptions = {},
): Promise<AgentStudioSyncResult> {
  const applicationId = options.applicationId || process.env.ALGOLIA_APPLICATION_ID;
  const apiKey = options.apiKey || process.env.ALGOLIA_ADMIN_API_KEY;
  const agentId = options.agentId || process.env.ALGOLIA_AGENT_ID;
  if (!applicationId || !apiKey || !agentId) {
    throw new Error("Missing ALGOLIA_APPLICATION_ID, ALGOLIA_ADMIN_API_KEY, or ALGOLIA_AGENT_ID");
  }

  const [toolsSource, instructions, searchSource, systemPrompt] = await Promise.all([
    readFile(
      options.toolsPath || resolve(process.cwd(), "agent-studio/tools/client-tools.json"),
      "utf8",
    ),
    readFile(
      options.promptPath || resolve(process.cwd(), "agent-studio/system-prompt.txt"),
      "utf8",
    ),
    readFile(
      options.searchToolPath || resolve(process.cwd(), "agent-studio/tools/algolia-search.json"),
      "utf8",
    ),
    readFile(
      options.systemPromptPath || resolve(process.cwd(), "agent-studio/system-prompt-block.txt"),
      "utf8",
    ),
  ]);
  const source = JSON.parse(toolsSource) as OpenAIFunctionTool[];
  if (!Array.isArray(source) || !source.length) throw new Error("No client-side tools were found");
  const searchSpec = JSON.parse(searchSource) as SearchToolSource;
  if (!searchSpec.indices?.length) throw new Error("No search indices were found");

  const clientTools: AgentTool[] = source.map((tool) => ({
    type: "client_side",
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
  }));
  const managedNames = new Set([
    ...clientTools.map((tool) => tool.name),
    "list_memories",
  ]);
  const fetcher = options.fetcher || fetch;
  const endpoint = `https://${applicationId}.algolia.net/agent-studio/1/agents/${encodeURIComponent(agentId)}`;
  const headers = {
    "content-type": "application/json",
    "x-algolia-application-id": applicationId,
    "x-algolia-api-key": apiKey,
  };

  const currentResponse = await fetcher(endpoint, { headers });
  if (!currentResponse.ok) throw await responseError(currentResponse, "Reading Agent Studio agent");
  const current = await currentResponse.json() as AgentResponse;
  // The search tool is now owned by the repo rather than the dashboard, so its
  // index descriptions and locks travel with the code that depends on them.
  const searchTool = buildSearchTool(
    searchSpec,
    (current.tools || []).find(tool => tool.type === searchSpec.type),
  );
  const preservedTools = (current.tools || []).filter(
    (tool) => tool.type !== searchSpec.type
      && (tool.type !== "client_side" || !managedNames.has(tool.name)),
  );

  const patchResponse = await fetcher(endpoint, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      instructions: instructions.trim(),
      systemPrompt: systemPrompt.trim(),
      tools: [searchTool, ...preservedTools, ...clientTools],
    }),
  });
  if (!patchResponse.ok) throw await responseError(patchResponse, "Updating Agent Studio tools");

  const publishResponse = await fetcher(`${endpoint}/publish`, {
    method: "POST",
    headers,
  });
  if (!publishResponse.ok) {
    const body = await publishResponse.text();
    const alreadyPublished = publishResponse.status === 409 && /already published/i.test(body);
    if (!alreadyPublished) {
      throw new Error(
        `Publishing Agent Studio agent failed (${publishResponse.status}): ${body.slice(0, 500) || publishResponse.statusText}`,
      );
    }
  }

  return {
    agentId,
    clientTools: clientTools.length,
    preservedTools: preservedTools.length,
    searchIndices: (searchTool.indices as unknown[]).length,
    published: true,
  };
}
