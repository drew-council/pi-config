/**
 * Lazy loader for pi-subagents.
 *
 * pi-subagents package skills and prompt templates are disabled in settings.json
 * package filters, and this extension removes the subagent tool from the active
 * tool set by default. Use /subagents-toggle to attach those resources for the
 * current Pi process:
 *
 *   /subagents-toggle            toggle attach/detach
 *   /subagents-toggle on         attach tools, skills, prompts, and commands
 *   /subagents-toggle attach     alias for `on`
 *   /subagents-toggle off        detach and reload without its resources
 *   /subagents-toggle status     show whether pi-subagents is attached
 *
 * Attachment survives session replacement (/new, /resume, /fork, and
 * /plan-implement) until /subagents-toggle off or process exit.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateActiveTools } from "./shared/tool-activation.js";

const ATTACHED_KEY = "__piSubagentsToggleAttached";
const PACKAGE_ROOT = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

const SUBCOMMANDS = [
  { value: "on", label: "on - attach pi-subagents resources" },
  { value: "attach", label: "attach - alias for on" },
  { value: "off", label: "off - detach pi-subagents resources" },
  { value: "status", label: "status - show attachment state" },
] as const;

function getGlobalStore(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function isAttached(): boolean {
  return getGlobalStore()[ATTACHED_KEY] === true;
}

function setAttached(attached: boolean): void {
  getGlobalStore()[ATTACHED_KEY] = attached;
}

async function reloadWithState(ctx: ExtensionCommandContext, attached: boolean): Promise<void> {
  setAttached(attached);
  if (ctx.hasUI) {
    ctx.ui.notify(
      attached ? "Attaching pi-subagents tools, skills, prompts, and slash commands..." : "Detaching pi-subagents...",
      "info",
    );
  }
  await ctx.reload();
}

async function attach(ctx: ExtensionCommandContext): Promise<void> {
  if (isAttached()) {
    if (ctx.hasUI) ctx.ui.notify("pi-subagents is already attached.", "info");
    return;
  }
  await reloadWithState(ctx, true);
}

async function detach(ctx: ExtensionCommandContext): Promise<void> {
  if (!isAttached()) {
    if (ctx.hasUI) ctx.ui.notify("pi-subagents is already detached.", "info");
    return;
  }
  await reloadWithState(ctx, false);
}

function applySubagentToolState(pi: ExtensionAPI): void {
  updateActiveTools(pi, isAttached() ? { add: ["subagent"] } : { remove: ["subagent"] });
}

export default async function subagentsToggle(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", () => {
    applySubagentToolState(pi);
  });

  pi.on("resources_discover", () => {
    if (!isAttached()) return;
    return {
      skillPaths: [SKILLS_DIR],
      promptPaths: [PROMPTS_DIR],
    };
  });

  pi.registerCommand("subagents-toggle", {
    description: "Toggle pi-subagents: [on|attach|off|status]",
    getArgumentCompletions: (prefix) =>
      prefix.includes(" ")
        ? null
        : SUBCOMMANDS.filter((sub) => sub.value.startsWith(prefix)).map(({ value, label }) => ({ value, label })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      switch (sub) {
        case "":
          await (isAttached() ? detach(ctx) : attach(ctx));
          return;
        case "on":
        case "attach":
          await attach(ctx);
          return;
        case "off":
          await detach(ctx);
          return;
        case "status":
          if (ctx.hasUI) {
            ctx.ui.notify(`pi-subagents is ${isAttached() ? "attached" : "detached"}.`, "info");
          }
          return;
        default:
          if (ctx.hasUI) {
            ctx.ui.notify("Usage: /subagents-toggle [on|attach|off|status]", "error");
          }
      }
    },
  });
}
