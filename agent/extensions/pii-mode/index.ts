import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  hasConversation,
  installCommandGuard,
  installRuntimeGuard,
  isPersisted,
  makeEphemeral,
  sessionPersistenceKnown,
} from "./guards.js";
import { LOCKED_CONFIG, modelAllowed, readConfig, toolAllowed } from "./policy.js";
import { PROMPT_SECTION, piiPrompt } from "./prompt.js";
import { activate, enterScratchDir, isActive, leaveScratchDir, piiState, sweepStaleScratchDirs } from "./state.js";

const FLAG = "pii";
const STATUS_KEY = "pii-mode";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function piiMode(pi: ExtensionAPI): void {
  registerPiiMode(pi, { agentDir: getAgentDir() });
}

export function registerPiiMode(pi: ExtensionAPI, options: { agentDir: string }): void {
  const state = piiState();
  try {
    state.config = readConfig(options.agentDir);
    state.configError = undefined;
  } catch (error) {
    state.config = LOCKED_CONFIG;
    state.configError = errorMessage(error);
  }
  state.missing = [...installRuntimeGuard(), ...installCommandGuard()];

  pi.registerFlag(FLAG, {
    type: "boolean",
    description: "Start in PII-safe mode: approved models only, nothing saved to disk",
  });

  /** Why PII-safe mode cannot be guaranteed here, if it cannot. */
  const unavailable = (ctx: ExtensionContext): string | undefined => {
    if (state.configError) return state.configError;
    if (state.missing.length > 0) return `pi internals changed (${state.missing.join(", ")}); update pii-mode.`;
    if (!sessionPersistenceKnown(ctx.sessionManager)) return "pi's SessionManager changed; update pii-mode.";
    return undefined;
  };

  const restrictTools = () => {
    const active = pi.getActiveTools();
    const allowed = active.filter((name) => toolAllowed(state.config, name));
    if (allowed.length !== active.length) pi.setActiveTools(allowed);
  };

  const candidates = (ctx: ExtensionContext, preferred?: Model<Api>): Model<Api>[] => {
    const { defaultModel } = state.config;
    const slash = defaultModel?.indexOf("/") ?? -1;
    const configured = defaultModel
      ? ctx.modelRegistry.find(defaultModel.slice(0, slash), defaultModel.slice(slash + 1))
      : undefined;
    return [preferred, configured, ...ctx.modelRegistry.getAvailable(), ...ctx.modelRegistry.getAll()].filter(
      (model): model is Model<Api> => modelAllowed(state.config, model),
    );
  };

  const enforceModel = async (ctx: ExtensionContext, preferred?: Model<Api>) => {
    if (modelAllowed(state.config, ctx.model)) return;
    for (const model of candidates(ctx, preferred)) {
      if (await pi.setModel(model)) return;
    }
    ctx.ui.notify("PII-safe mode: no allowed model is available, so every model request will be refused.", "error");
  };

  pi.on("session_start", async (_event, ctx) => {
    sweepStaleScratchDirs();
    if (pi.getFlag(FLAG) === true && !isActive()) activate();
    if (!isActive()) return;
    const problem = unavailable(ctx);
    if (problem) {
      ctx.ui.notify(`PII-safe mode cannot run: ${problem} Exiting.`, "error");
      ctx.shutdown();
      return;
    }
    if (isPersisted(ctx.sessionManager) && hasConversation(ctx.sessionManager)) {
      ctx.ui.notify("PII-safe mode always starts a fresh session and cannot continue a saved one. Exiting.", "error");
      ctx.shutdown();
      return;
    }
    makeEphemeral(ctx.sessionManager);
    enterScratchDir();
    restrictTools();
    await enforceModel(ctx);
    ctx.ui.setStatus(STATUS_KEY, "PII-safe");
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit" && isActive()) leaveScratchDir();
  });

  // /resume and /import open a saved session file, which pi would keep writing to.
  // /new, /fork and /clone stay in memory, since pi copies the outgoing session's mode.
  pi.on("session_before_switch", (event, ctx) => {
    if (!isActive() || event.reason !== "resume") return;
    ctx.ui.notify("Opening saved sessions is disabled in PII-safe mode. Exit pi first.", "error");
    return { cancel: true };
  });

  pi.on("model_select", async (event, ctx) => {
    if (!isActive() || modelAllowed(state.config, event.model)) return;
    ctx.ui.notify(`${event.model.provider}/${event.model.id} cannot be used in PII-safe mode.`, "warning");
    await enforceModel(ctx, event.previousModel);
  });

  // Nested codemode calls raise tool_call too, so this also covers codemode-only tools.
  pi.on("tool_call", (event) => {
    if (!isActive() || toolAllowed(state.config, event.toolName)) return;
    return {
      block: true,
      reason: `${event.toolName} is disabled in PII-safe mode. Allowed tools: ${state.config.allowedTools.join(", ")}.`,
    };
  });

  pi.on("before_agent_start", (event) => {
    if (!isActive()) return;
    // Tools registered since session start (MCP servers, lazy extensions) are dropped here.
    restrictTools();
    event.systemPromptOptions.sections[PROMPT_SECTION] = piiPrompt(state.scratchDir);
  });

  pi.registerCommand("pii", {
    description: "Enter PII-safe mode: approved models only, nothing saved to disk. Exit pi to leave it",
    handler: async (_args, ctx) => {
      if (isActive()) {
        ctx.ui.notify(`PII-safe mode is on (scratch directory ${state.scratchDir}). Exit pi to leave it.`, "info");
        return;
      }
      const problem = unavailable(ctx);
      if (problem) {
        ctx.ui.notify(`PII-safe mode is unavailable: ${problem}`, "error");
        return;
      }
      if (
        ctx.hasUI &&
        !(await ctx.ui.confirm(
          "Enter PII-safe mode?",
          "This starts a fresh session that is kept only in memory, and limits models and tools for the rest of this pi process. It cannot be turned off: exit pi to leave it. The current session is left as it is.",
        ))
      ) {
        return;
      }
      await ctx.waitForIdle();
      const undo = activate();
      try {
        const { cancelled } = await ctx.newSession({
          withSession: async (next) => {
            const model = next.model ? `${next.model.provider}/${next.model.id}` : "no model";
            next.ui.notify(`PII-safe mode is on (${model}). Nothing is saved to disk. Exit pi to leave it.`, "info");
          },
        });
        if (cancelled) {
          undo();
          ctx.ui.notify("PII-safe mode was not entered: another extension cancelled the new session.", "error");
        }
      } catch (error) {
        // The previous session may already be gone; staying in PII-safe mode and exiting is the only safe state.
        ctx.ui.notify(`Could not start a PII-safe session: ${errorMessage(error)}. Exiting.`, "error");
        ctx.shutdown();
      }
    },
  });
}
