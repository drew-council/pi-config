import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeImplementPrompt, makePlanPrompt } from "./prompt.js";

const PCLOUD_PLANS_ROOT = path.join(homedir(), "pCloudDrive", "pi-agent", "plans");
const FALLBACK_PLANS_ROOT = path.join(homedir(), ".pi", "agent", "plans");
const MAX_PLAN_CHOICES = 20;

interface PlanFile {
  path: string;
  dir: string;
  filename: string;
  mtimeMs: number;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Resolve the plans root: prefer the pCloud-synced directory when pCloud is
 * mounted, otherwise fall back to a gitignored directory under ~/.pi.
 */
async function resolvePlansRoot(): Promise<string> {
  try {
    const driveStat = await stat(path.join(homedir(), "pCloudDrive"));
    if (driveStat.isDirectory()) return PCLOUD_PLANS_ROOT;
  } catch {}
  return FALLBACK_PLANS_ROOT;
}

async function listPlanFiles(): Promise<PlanFile[]> {
  const plansRoot = await resolvePlansRoot();
  let dirs: string[];
  try {
    dirs = await readdir(plansRoot);
  } catch {
    return [];
  }

  const plans: PlanFile[] = [];
  for (const dirname of dirs) {
    const dir = path.join(plansRoot, dirname);
    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) continue;
      for (const filename of await readdir(dir)) {
        if (!filename.endsWith(".md")) continue;
        const filePath = path.join(dir, filename);
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          plans.push({ path: filePath, dir, filename, mtimeMs: Math.max(fileStat.mtimeMs, dirStat.mtimeMs) });
        }
      }
    } catch {}
  }

  return plans.sort((a, b) => {
    const dirCompare = path.basename(b.dir).localeCompare(path.basename(a.dir));
    if (dirCompare !== 0) return dirCompare;
    return b.mtimeMs - a.mtimeMs;
  });
}

function formatPlanLabel(plan: PlanFile, index: number): string {
  const date = new Date(plan.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
  const dirName = path.basename(plan.dir);
  return `${String(index + 1).padStart(2, "0")}. ${date}  ${dirName}/${plan.filename}`;
}

export default function planExtension(pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description:
      "Create a plan directory in ~/pCloudDrive/pi-agent/plans/<timestamp>/ (falls back to ~/.pi/agent/plans when pCloud is unavailable) and prompt the agent to write a plan there",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /plan <description>", "warning");
        return;
      }

      const plansRoot = await resolvePlansRoot();
      const dir = path.join(plansRoot, timestamp());
      await mkdir(dir, { recursive: true });

      ctx.ui.notify(`Plan directory: ${dir}`, "info");
      await pi.sendUserMessage(makePlanPrompt(description, dir));
    },
  });

  pi.registerCommand("plan-implement", {
    description: "Select one of the 20 most recent plans and send an implementation prompt for it",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/plan-implement requires an interactive UI for plan selection.", "warning");
        return;
      }

      const plans = (await listPlanFiles()).slice(0, MAX_PLAN_CHOICES);
      if (plans.length === 0) {
        ctx.ui.notify(`No plans found in ${await resolvePlansRoot()}`, "warning");
        return;
      }

      const labels = plans.map(formatPlanLabel);
      const selected = await ctx.ui.select("Select a plan to implement", labels);
      if (!selected) return;

      const plan = plans[labels.indexOf(selected)];
      if (!plan) return;

      const prompt = makeImplementPrompt(plan.path, await readFile(plan.path, "utf8"));
      await pi.sendUserMessage(prompt);
    },
  });
}
