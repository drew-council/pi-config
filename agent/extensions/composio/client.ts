import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertComposioToolAllowed, type ComposioPolicy, isComposioToolAllowed } from "./config.js";

export interface ComposioConnection {
  policy: ComposioPolicy;
  search(query: string, toolkits?: string[], signal?: AbortSignal): Promise<unknown>;
  execute(slug: string, args: Record<string, unknown>, account?: string, signal?: AbortSignal): Promise<unknown>;
  manageConnections(toolkits: string[], reinitiate: boolean, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface McpPayload {
  structuredContent?: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Connect sometimes adds prose after its JSON payload; parse the payload separately. */
export function decodeComposioResult(result: McpPayload): unknown {
  if (result.structuredContent) return result.structuredContent;
  const texts = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "");
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Other content blocks can be plain text.
    }
  }
  return { successful: !result.isError, data: texts.join("\n"), error: result.isError ? texts.join("\n") : null };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function filterComposioSearch(value: unknown, policy: ComposioPolicy): unknown {
  const payload = object(value);
  const data = object(payload.data);
  if (!payload.data) return value;
  const filtered = { ...data };
  if (data.tool_schemas) {
    filtered.tool_schemas = Object.fromEntries(
      Object.entries(object(data.tool_schemas)).filter(([slug]) => isComposioToolAllowed(policy, slug)),
    );
  }
  if (Array.isArray(data.results)) {
    filtered.results = data.results.map((item) => {
      const result = { ...object(item) };
      for (const key of ["primary_tool_slugs", "related_tool_slugs"]) {
        if (Array.isArray(result[key])) {
          result[key] = result[key].filter((slug) => typeof slug === "string" && isComposioToolAllowed(policy, slug));
        }
      }
      return result;
    });
  }
  if (Array.isArray(data.toolkit_connection_statuses)) {
    filtered.toolkit_connection_statuses = data.toolkit_connection_statuses.filter((item) =>
      policy.toolkits.includes(String(object(item).toolkit)),
    );
  }
  return { ...payload, data: filtered };
}

export async function connectComposio(
  apiKey: string,
  policy: ComposioPolicy,
  signal?: AbortSignal,
): Promise<ComposioConnection> {
  const client = new Client({ name: "pi-composio", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://connect.composio.dev/mcp"), {
    requestInit: { headers: { "x-consumer-api-key": apiKey } },
  });
  const safeError = (error: unknown) =>
    new Error((error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "[REDACTED]"));

  try {
    await client.connect(transport, { signal, timeout: 20_000 });
    const tools = await client.listTools({}, { signal, timeout: 20_000 });
    for (const name of [
      "COMPOSIO_SEARCH_TOOLS",
      "COMPOSIO_GET_TOOL_SCHEMAS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "COMPOSIO_MANAGE_CONNECTIONS",
    ]) {
      if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`Composio is missing ${name}.`);
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw safeError(error);
  }

  return createComposioConnection(
    policy,
    async (name, args, requestSignal) => {
      try {
        const response = await client.callTool({ name, arguments: args }, undefined, {
          signal: requestSignal,
          timeout: 60_000,
        });
        return response as McpPayload;
      } catch (error) {
        throw safeError(error);
      }
    },
    () => client.close(),
  );
}

type ComposioMcpCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpPayload>;

export function createComposioConnection(
  policy: ComposioPolicy,
  mcpCall: ComposioMcpCall,
  close: () => Promise<void>,
): ComposioConnection {
  let sessionId: string | undefined;
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await mcpCall(name, args, signal);
    const result = decodeComposioResult(response);
    if (response.isError || object(result).successful === false) {
      throw new Error(`Composio ${name} failed: ${JSON.stringify(object(result).error ?? result)}`);
    }
    const id = object(object(object(result).data).session).id;
    if (typeof id === "string") sessionId = id;
    return result;
  };
  const withSession = (args: Record<string, unknown>) => ({ ...args, ...(sessionId ? { session_id: sessionId } : {}) });
  const checkToolkits = (toolkits: string[]) => {
    for (const toolkit of toolkits) {
      if (!policy.toolkits.includes(toolkit)) throw new Error(`Composio policy does not allow toolkit ${toolkit}.`);
    }
  };

  return {
    policy,
    async search(query, toolkits, requestSignal) {
      const allowed = toolkits?.length ? toolkits : policy.toolkits;
      checkToolkits(allowed);
      if (!allowed.length) throw new Error("No Composio toolkits are enabled in composio.json.");
      const hint = ` Use only these toolkits: ${allowed.join(", ")}.`;
      const result = await call(
        "COMPOSIO_SEARCH_TOOLS",
        {
          queries: [{ use_case: query.slice(0, 1024 - hint.length) + hint }],
          session: sessionId ? { id: sessionId } : { generate_id: true },
        },
        requestSignal,
      );
      return filterComposioSearch(result, { ...policy, toolkits: allowed });
    },
    async execute(slug, args, account, requestSignal) {
      if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") {
        if (!Array.isArray(args.tool_slugs) || !args.tool_slugs.every((item) => typeof item === "string")) {
          throw new Error("COMPOSIO_GET_TOOL_SCHEMAS requires a tool_slugs array.");
        }
        for (const tool of args.tool_slugs) assertComposioToolAllowed(policy, tool);
        return call(
          slug,
          withSession({ tool_slugs: args.tool_slugs, include: args.include ?? ["input_schema"] }),
          requestSignal,
        );
      }
      assertComposioToolAllowed(policy, slug);
      return call(
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        withSession({
          tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }],
          sync_response_to_workbench: false,
          current_step: "EXECUTING_TOOL",
        }),
        requestSignal,
      );
    },
    async manageConnections(toolkits, reinitiate, requestSignal) {
      checkToolkits(toolkits);
      // Listing has no side effects; adding a connection requires reinitiate_all=true.
      return call(
        "COMPOSIO_MANAGE_CONNECTIONS",
        withSession({ toolkits: toolkits.map((name) => ({ name, action: reinitiate ? "add" : "list" })) }),
        requestSignal,
      );
    },
    close,
  };
}
