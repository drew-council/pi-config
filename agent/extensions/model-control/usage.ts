import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProfileName } from "../shared/accounts.js";

export type ModelUsageEvent = {
  usedAt: number;
  profile: ProfileName;
  provider: string;
  model: string;
  thinking: ModelThinkingLevel;
};

export type ModelEffortKey = Pick<ModelUsageEvent, "provider" | "model" | "thinking">;

export const modelUsagePath = (agentDir: string): string => join(agentDir, "model-usage.jsonl");
export const pairKey = ({ provider, model, thinking }: ModelEffortKey): string => `${provider}\0${model}\0${thinking}`;

function isUsageEvent(value: unknown): value is ModelUsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.usedAt === "number" &&
    Number.isFinite(event.usedAt) &&
    (event.profile === "work" || event.profile === "personal") &&
    typeof event.provider === "string" &&
    typeof event.model === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(event.thinking))
  );
}

export function appendModelUsage(agentDir: string, event: ModelUsageEvent): void {
  appendFileSync(modelUsagePath(agentDir), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readRecentUsage(agentDir: string, profile: ProfileName): Map<string, number> {
  let contents: string;
  try {
    contents = readFileSync(modelUsagePath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    return new Map();
  }
  const recent = new Map<string, number>();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!isUsageEvent(event) || event.profile !== profile) continue;
      const key = pairKey(event);
      if ((recent.get(key) ?? Number.NEGATIVE_INFINITY) < event.usedAt) recent.set(key, event.usedAt);
    } catch {
      // A partial final append must not make the picker unusable.
    }
  }
  return recent;
}

export function createActualUseRecorder(
  agentDir: string,
  getProfile: () => ProfileName,
  now: () => number = Date.now,
): {
  markPending(): void;
  cancel(): void;
  recordBeforeProvider(ctx: { model?: Model<Api>; thinkingLevel?: ModelThinkingLevel }): boolean;
} {
  let pending = false;
  return {
    markPending() {
      pending = true;
    },
    cancel() {
      pending = false;
    },
    recordBeforeProvider(ctx) {
      if (!pending) return false;
      pending = false;
      if (!ctx.model) return false;
      appendModelUsage(agentDir, {
        usedAt: now(),
        profile: getProfile(),
        provider: ctx.model.provider,
        model: ctx.model.id,
        thinking: ctx.thinkingLevel ?? "off",
      });
      return true;
    },
  };
}

export function compareByRecentUsage(
  a: ModelEffortKey,
  b: ModelEffortKey,
  recent: ReadonlyMap<string, number>,
): number {
  const aTime = recent.get(pairKey(a));
  const bTime = recent.get(pairKey(b));
  if (aTime !== undefined || bTime !== undefined) {
    if (aTime === undefined) return 1;
    if (bTime === undefined) return -1;
    if (aTime !== bTime) return bTime - aTime;
  }
  return `${a.provider}/${a.model}:${a.thinking}`.localeCompare(`${b.provider}/${b.model}:${b.thinking}`);
}

export const _test = { isUsageEvent };
