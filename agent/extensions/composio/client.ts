import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  assertComposioToolAllowed,
  type ComposioPolicy,
  isComposioToolAllowed,
  isComposioToolkitAllowed,
} from "./config.js";

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
      isComposioToolkitAllowed(policy, String(object(item).toolkit)),
    );
  }
  return { ...payload, data: filtered };
}

/** Backoff between resends of a request that Connect's edge rejected; about 15s in total. */
const RETRY_DELAYS_MS = [250, 500, 1000, 1000, 2000, 2000, 3000, 3000];

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Connect's Cloudflare edge rejects about half of authenticated requests with a fast 502, at any request rate.
 * Those requests never reach Composio (rejected tool calls do not appear in the activity log), so any request,
 * including an app action, can be resent. Other statuses are returned unchanged.
 */
export function createRetryingFetch(baseFetch: typeof fetch = fetch, delays = RETRY_DELAYS_MS): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const response = await baseFetch(input, init);
      if ((response.status !== 502 && response.status !== 503) || attempt >= delays.length) return response;
      await response.body?.cancel().catch(() => {});
      await delay(delays[attempt], init?.signal);
    }
  }) as typeof fetch;
}

export async function connectComposio(
  apiKey: string,
  policy: ComposioPolicy,
  signal?: AbortSignal,
): Promise<ComposioConnection> {
  const client = new Client({ name: "pi-composio", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://connect.composio.dev/mcp"), {
    requestInit: { headers: { "x-consumer-api-key": apiKey } },
    fetch: createRetryingFetch(),
  });
  const safeError = (error: unknown) =>
    new Error((error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "[REDACTED]"));

  try {
    await client.connect(transport, { signal, timeout: 30_000 });
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
          timeout: 90_000,
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
      if (!isComposioToolkitAllowed(policy, toolkit)) {
        throw new Error(`Composio policy does not allow toolkit ${toolkit}.`);
      }
    }
  };

  return {
    policy,
    async search(query, toolkits, requestSignal) {
      checkToolkits(toolkits ?? []);
      const hint = toolkits?.length ? ` Use only these toolkits: ${toolkits.join(", ")}.` : "";
      const result = await call(
        "COMPOSIO_SEARCH_TOOLS",
        {
          queries: [{ use_case: query.slice(0, 1024 - hint.length) + hint }],
          session: sessionId ? { id: sessionId } : { generate_id: true },
        },
        requestSignal,
      );
      return filterComposioSearch(result, policy);
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
