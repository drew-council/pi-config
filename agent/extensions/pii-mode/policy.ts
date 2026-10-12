import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelRule = { provider: string; id: string };

export type PiiModeConfig = {
  /** Models that may receive session data: `provider` matches exactly, `id` is a regular expression. */
  models: readonly ModelRule[];
  /** `provider/id` to switch to on entry. Defaults to the first available allowed model. */
  defaultModel?: string;
  /** Tools the model may call, directly or from codemode. Every other tool is blocked. */
  allowedTools: readonly string[];
};

export const DEFAULT_CONFIG: PiiModeConfig = {
  models: [{ provider: "google-vertex", id: "^gemini-" }],
  // Built-in local tools, codemode (whose nested calls are checked individually), and ask_user.
  allowedTools: ["read", "bash", "edit", "write", "find", "grep", "ls", "codemode", "ask_user"],
};

/** Allows nothing; used when the configuration cannot be trusted. */
export const LOCKED_CONFIG: PiiModeConfig = { models: [], allowedTools: [] };

export const configPath = (agentDir: string) => join(agentDir, "pii-mode.json");

/** Reads `<agentDir>/pii-mode.json`; each present key replaces the default. Throws when invalid. */
export function readConfig(agentDir: string): PiiModeConfig {
  const path = configPath(agentDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object.`);
  const value = raw as Record<string, unknown>;
  const config: PiiModeConfig = { ...DEFAULT_CONFIG };
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || !value.models.every(isModelRule)) {
      throw new Error(`${path}: "models" must be a list of { "provider", "id" } strings.`);
    }
    for (const rule of value.models) new RegExp(rule.id);
    config.models = value.models;
  }
  if (value.defaultModel !== undefined) {
    if (typeof value.defaultModel !== "string" || !value.defaultModel.includes("/")) {
      throw new Error(`${path}: "defaultModel" must be a "provider/id" string.`);
    }
    config.defaultModel = value.defaultModel;
  }
  if (value.allowedTools !== undefined) {
    if (!Array.isArray(value.allowedTools) || !value.allowedTools.every((tool) => typeof tool === "string")) {
      throw new Error(`${path}: "allowedTools" must be a list of tool names.`);
    }
    config.allowedTools = value.allowedTools;
  }
  return config;
}

const isModelRule = (rule: unknown): rule is ModelRule =>
  !!rule &&
  typeof (rule as ModelRule).provider === "string" &&
  typeof (rule as ModelRule).id === "string" &&
  (rule as ModelRule).id.length > 0;

/** Only chat models matching a rule may receive data. Classifier, image and unknown types never do. */
export function modelAllowed(
  config: PiiModeConfig,
  model: { provider: string; id: string; type?: string } | undefined,
): boolean {
  if (!model || (model.type ?? "chat") !== "chat") return false;
  return config.models.some((rule) => rule.provider === model.provider && new RegExp(rule.id).test(model.id));
}

export const toolAllowed = (config: PiiModeConfig, toolName: string): boolean => config.allowedTools.includes(toolName);
