import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { createPiComposioSystemPrompt, PiProvider, type PiToolDetails } from "@composio/experimental";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { updateActiveTools } from "../shared/tool-activation.js";
import { type ComposioConnection, connectComposio } from "./client.js";
import { readComposioKey, readComposioPolicy } from "./config.js";

const ENABLED_BY_DEFAULT = false;
const TOOL_NAMES = ["composio_search_tools", "composio_manage_connections", "composio_execute_tool"];
const CODEMODE_GUIDANCE =
  "In codemode, await tools.composio_search_tools(), tools.composio_execute_tool(), or tools.composio_manage_connections(). Calls return the decoded Composio response object, not a JSON string or an MCP content wrapper. The data shape depends on the discovered tool. Await discovery before dependent calls; independent calls may use Promise.allSettled(). Return only the fields needed by the task. Failures may reject; do not automatically retry actions that could already have changed an app.";
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

interface ComposioExtensionOptions {
  connect?: (signal: AbortSignal) => Promise<ComposioConnection>;
}

export function registerComposio(pi: ExtensionAPI, options: ComposioExtensionOptions = {}): void {
  const agentDir = getAgentDir();
  const connect =
    options.connect ??
    ((signal: AbortSignal) =>
      connectComposio(
        readComposioKey(join(agentDir, "..", "secrets", "personal.json")),
        readComposioPolicy(join(agentDir, "composio.json")),
        signal,
      ));
  const signals = new AsyncLocalStorage<AbortSignal>();
  let connection: ComposioConnection | undefined;
  let pending: Promise<void> | undefined;
  let attempt: AbortController | undefined;
  let generation = 0;

  const requireConnection = (): ComposioConnection => {
    if (!connection)
      throw new Error("Composio is disabled. The user must run /composio to enable it for this session.");
    return connection;
  };
  const tools = new PiProvider({ catchErrors: false }).createSessionTools({
    search: ({ query, toolkits }) => requireConnection().search(query, toolkits, signals.getStore()),
    execute: (slug, args, options) => requireConnection().execute(slug, args, options?.account, signals.getStore()),
    hooks: {
      manageConnections: (ctx) =>
        requireConnection().manageConnections(ctx.request.toolkits, ctx.request.reinitiateAll, signals.getStore()),
    },
    includeWorkbenchTools: false,
  });

  for (const tool of tools) {
    pi.registerTool({
      ...tool,
      // Keep direct exposure: codemode/deferred tools remain callable even while inactive.
      exposure: "direct",
      defaultActive: ENABLED_BY_DEFAULT,
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
        requireConnection();
        const result = await signals.run(signal, () => tool.execute(id, params, signal, onUpdate, ctx));
        // PiProvider keeps the decoded payload in details.result independently of its text formatter.
        const response = (result.details as PiToolDetails).result;
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          throw new Error("Composio returned a non-object response.");
        }
        return { ...result, structuredContent: response as JsonValue };
      },
    });
  }

  const disable = async (ctx: ExtensionContext) => {
    generation += 1;
    attempt?.abort();
    attempt = undefined;
    pending = undefined;
    const previous = connection;
    connection = undefined;
    updateActiveTools(pi, { remove: TOOL_NAMES });
    ctx.ui.setStatus("composio", undefined);
    await previous?.close().catch(() => {});
  };

  const enable = async (ctx: ExtensionContext) => {
    if (connection) {
      ctx.ui.notify("Composio is already connected for this session.", "info");
      return;
    }
    if (pending) return pending;
    const current = ++generation;
    const controller = new AbortController();
    attempt = controller;
    ctx.ui.setStatus("composio", ctx.ui.theme.fg("dim", "Composio connecting…"));
    pending = Promise.resolve().then(async () => {
      try {
        const connected = await connect(controller.signal);
        if (generation !== current) {
          await connected.close();
          return;
        }
        connection = connected;
        updateActiveTools(pi, { add: TOOL_NAMES });
        ctx.ui.setStatus("composio", ctx.ui.theme.fg("success", "Composio connected"));
        ctx.ui.notify(`Composio connected (${connected.policy.toolkits.join(", ")}).`, "info");
      } catch (error) {
        if (generation !== current) return;
        connection = undefined;
        updateActiveTools(pi, { remove: TOOL_NAMES });
        ctx.ui.setStatus("composio", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : "Could not connect to Composio.", "error");
      } finally {
        if (generation === current) {
          pending = undefined;
          attempt = undefined;
        }
      }
    });
    return pending;
  };

  pi.on("session_start", async (_event, ctx) => {
    await disable(ctx);
    if (ENABLED_BY_DEFAULT) await enable(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => disable(ctx));
  pi.on("tool_call", (event) => {
    if (TOOL_NAMES.includes(event.toolName) && !connection) {
      return { block: true, reason: "Composio is disabled. Run /composio to enable it for this session." };
    }
  });
  pi.on("before_agent_start", (event) => {
    if (!connection) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${createPiComposioSystemPrompt()}\nAllowed Composio toolkits: ${connection.policy.toolkits.join(", ")}.\nFor missing schemas, use composio_execute_tool with toolSlug COMPOSIO_GET_TOOL_SCHEMAS and arguments {tool_slugs: [exact tool slugs]}.\nConnection management lists accounts by default; reinitiate_all=true starts an OAuth connection.\n${CODEMODE_GUIDANCE}`,
    };
  });
  pi.registerCommand("composio", {
    description: "Enable Composio for this session; /composio off disconnects, /composio status shows state",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      switch (args.trim()) {
        case "":
        case "on":
          await enable(ctx);
          break;
        case "off":
          await disable(ctx);
          ctx.ui.notify("Composio disabled for this session.", "info");
          break;
        case "status":
          ctx.ui.notify(
            connection
              ? `Composio connected (${connection.policy.toolkits.join(", ")}).`
              : pending
                ? "Composio is connecting."
                : "Composio is disabled. Run /composio to connect.",
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
