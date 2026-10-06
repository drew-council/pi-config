import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { createPiComposioSystemPrompt, PiProvider, type PiToolDetails } from "@composio/experimental";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { updateActiveTools } from "../shared/tool-activation.js";
import { type ComposioConnection, connectComposio } from "./client.js";
import { type ComposioPolicy, readComposioKey, readComposioPolicy } from "./config.js";

const TOOL_NAMES = ["composio_search_tools", "composio_manage_connections", "composio_execute_tool"];
const DISABLED_REASON = "Composio is disabled. Run /composio to enable it for this session.";
const CODEMODE_ONLY_REASON =
  "Composio tools are only callable from codemode scripts. Call codemode and await tools.composio_search_tools(), tools.composio_execute_tool(), or tools.composio_manage_connections() inside the script.";
const CODEMODE_GUIDANCE =
  "Composio tools are not declared directly; call them only from codemode scripts. In codemode, await tools.composio_search_tools(), tools.composio_execute_tool(), or tools.composio_manage_connections(). Calls return the decoded Composio response object, not a JSON string or an MCP content wrapper. The data shape depends on the discovered tool. Await discovery before dependent calls; independent calls may use Promise.allSettled(). Return only the fields needed by the task. Transient gateway errors are already retried; other failures reject, and actions that could already have changed an app must not be retried automatically.";
const COMPOSIO_NAMESPACE = {
  name: "composio",
  description: "Search schemas and use the user's connected apps through the policy-restricted Composio connector.",
  instructions: `${createPiComposioSystemPrompt()}\n${CODEMODE_GUIDANCE}\nOnly the user can enable this connector with /composio. Local toolkit/action policy applies to every call, including schema lookups. COMPOSIO_GET_TOOL_SCHEMAS is the only executable meta-tool; remote Bash, workbench, and raw proxy access are unavailable. Connection management lists accounts by default; reinitiate_all=true starts OAuth.`,
};
const COMPOSIO_OUTPUT_SCHEMA = Type.Object(
  {
    successful: Type.Optional(Type.Boolean()),
    data: Type.Optional(Type.Unknown({ description: "Service payload; its shape depends on the discovered tool." })),
    error: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true, description: "Decoded Composio response, preserving all service fields." },
);

export interface ComposioConfig {
  apiKey: string;
  policy: ComposioPolicy;
}

interface ComposioExtensionOptions {
  /** Reads the key and policy when the user enables Composio. */
  loadConfig?: () => ComposioConfig;
  /** Opens the connection on the first call after enabling. */
  connect?: (config: ComposioConfig, signal: AbortSignal) => Promise<ComposioConnection>;
}

export function registerComposio(pi: ExtensionAPI, options: ComposioExtensionOptions = {}): void {
  const agentDir = getAgentDir();
  const loadConfig =
    options.loadConfig ??
    (() => ({
      apiKey: readComposioKey(join(agentDir, "..", "secrets", "personal.json")),
      policy: readComposioPolicy(join(agentDir, "composio.json")),
    }));
  const connect = options.connect ?? ((config, signal) => connectComposio(config.apiKey, config.policy, signal));
  const signals = new AsyncLocalStorage<AbortSignal>();
  // Set while enabled. Enabling is local; the connection opens on the first call and is shared afterwards.
  let enabled: { config: ComposioConfig; abort: AbortController; connection?: Promise<ComposioConnection> } | undefined;

  const connection = (): Promise<ComposioConnection> => {
    const current = enabled;
    if (!current) return Promise.reject(new Error(DISABLED_REASON));
    if (!current.connection) {
      const opening = Promise.resolve()
        .then(() => connect(current.config, current.abort.signal))
        .catch((error) => {
          // A failed connection is retried by the next call.
          if (current.connection === opening) current.connection = undefined;
          throw error;
        });
      current.connection = opening;
    }
    return current.connection;
  };

  // Wait for the shared connection; each call's own cancellation ends only its wait.
  const connected = (): Promise<ComposioConnection> => {
    const signal = signals.getStore();
    if (!signal) return connection();
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      connection()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  };

  const tools = new PiProvider({ catchErrors: false }).createSessionTools({
    search: async ({ query, toolkits }) => (await connected()).search(query, toolkits, signals.getStore()),
    execute: async (slug, args, options) =>
      (await connected()).execute(slug, args, options?.account, signals.getStore()),
    hooks: {
      manageConnections: async (ctx) =>
        (await connected()).manageConnections(ctx.request.toolkits, ctx.request.reinitiateAll, signals.getStore()),
    },
    includeWorkbenchTools: false,
  });

  const definitions = tools.map((tool) => ({
    ...tool,
    namespace: COMPOSIO_NAMESPACE,
    outputSchema: COMPOSIO_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: tool.name === "composio_search_tools",
      destructiveHint: tool.name !== "composio_search_tools",
      idempotentHint: tool.name === "composio_search_tools",
      openWorldHint: true,
    },
    promptGuidelines: [
      ...(tool.promptGuidelines ?? []),
      "Composio calls in codemode return decoded response objects; do not JSON.parse them. Await discovery before dependent calls.",
    ],
    execute: async (id, params, signal, onUpdate, ctx) => {
      if (!enabled) throw new Error(DISABLED_REASON);
      const result = await signals.run(signal, () => tool.execute(id, params, signal, onUpdate, ctx));
      // PiProvider keeps the decoded payload in details.result independently of its text formatter.
      const response = (result.details as PiToolDetails).result;
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("Composio returned a non-object response.");
      }
      return { ...result, structuredContent: response as JsonValue };
    },
  }));

  // Hidden tools are unreachable; codemode tools are callable from scripts but never declared to the model.
  let exposed: boolean | undefined;
  const expose = (on: boolean) => {
    if (exposed === on) return;
    exposed = on;
    for (const definition of definitions) pi.registerTool({ ...definition, exposure: on ? "codemode" : "hidden" });
  };
  expose(false);

  const enable = (ctx: ExtensionContext) => {
    if (enabled) return ctx.ui.notify("Composio is already on for this session.", "info");
    let config: ComposioConfig;
    try {
      config = loadConfig();
    } catch (error) {
      return ctx.ui.notify(error instanceof Error ? error.message : "Could not read the Composio config.", "error");
    }
    enabled = { config, abort: new AbortController() };
    expose(true);
    updateActiveTools(pi, { add: ["codemode"], remove: TOOL_NAMES });
    ctx.ui.setStatus("composio", ctx.ui.theme.fg("success", "Composio on"));
    ctx.ui.notify(`Composio on (${config.policy.toolkits.join(", ")}).`, "info");
  };

  const disable = (ctx: ExtensionContext) => {
    const previous = enabled;
    enabled = undefined;
    expose(false);
    ctx.ui.setStatus("composio", undefined);
    if (!previous) return;
    previous.abort.abort();
    previous.connection?.then((open) => open.close()).catch(() => {});
  };

  pi.on("session_start", (_event, ctx) => disable(ctx));
  pi.on("session_shutdown", (_event, ctx) => disable(ctx));
  pi.on("tool_call", (event) => {
    if (!TOOL_NAMES.includes(event.toolName)) return;
    if (!enabled) return { block: true, reason: DISABLED_REASON };
    // Nested calls carry the calling tool's id; model-issued calls (including tool_search loads) do not.
    if (!event.parentToolCallId) return { block: true, reason: CODEMODE_ONLY_REASON };
  });
  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${createPiComposioSystemPrompt()}\nAllowed Composio toolkits: ${enabled.config.policy.toolkits.join(", ")}.\nFor missing schemas, use composio_execute_tool with toolSlug COMPOSIO_GET_TOOL_SCHEMAS and arguments {tool_slugs: [exact tool slugs]}.\nConnection management lists accounts by default; reinitiate_all=true starts an OAuth connection.\n${CODEMODE_GUIDANCE}`,
    };
  });
  pi.registerCommand("composio", {
    description: "Enable Composio for this session; /composio off disables it, /composio status shows state",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      switch (args.trim()) {
        case "":
        case "on":
          enable(ctx);
          break;
        case "off":
          disable(ctx);
          ctx.ui.notify("Composio disabled for this session.", "info");
          break;
        case "status":
          ctx.ui.notify(
            enabled
              ? `Composio is on (${enabled.config.policy.toolkits.join(", ")}).`
              : "Composio is off. Run /composio to enable it.",
            "info",
          );
          break;
        default:
          ctx.ui.notify("Usage: /composio [on|off|status]", "warning");
      }
    },
  });
}

export default function composio(pi: ExtensionAPI): void {
  registerComposio(pi);
}
