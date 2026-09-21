import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type ProfileName, readJson } from "../shared/accounts.js";

export type ModelEffortPreference = {
  provider: string;
  model: string;
  thinking: ModelThinkingLevel;
};

export type ModelDefaults = {
  version: 1;
  profiles: Record<ProfileName, ModelEffortPreference>;
};

const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const settingsMarker = Symbol.for("pi.model-control.settings-policy");

type SettingsPolicyState = {
  getProfile: () => ProfileName;
  getPreference: (profile: ProfileName) => ModelEffortPreference;
  savePreference: (profile: ProfileName, preference: ModelEffortPreference) => void;
};

type SettingsTarget = Pick<
  SettingsManager,
  | "getDefaultProvider"
  | "getDefaultModel"
  | "setDefaultProvider"
  | "setDefaultModel"
  | "setDefaultModelAndProvider"
  | "getDefaultThinkingLevel"
  | "setDefaultThinkingLevel"
>;

function isPreference(value: unknown): value is ModelEffortPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    typeof candidate.thinking === "string" &&
    THINKING_LEVELS.has(candidate.thinking as ModelThinkingLevel)
  );
}

export const modelDefaultsPath = (agentDir: string): string => join(agentDir, "model-defaults.json");

export function readModelDefaults(agentDir: string): ModelDefaults {
  try {
    const value = readJson(modelDefaultsPath(agentDir));
    const profiles = value.profiles as Record<string, unknown> | undefined;
    if (value.version !== 1 || !profiles) throw new Error("unsupported model defaults schema");
    const work = profiles.work;
    const personal = profiles.personal;
    if (!isPreference(work) || !isPreference(personal)) throw new Error("invalid model defaults");
    return { version: 1, profiles: { work: { ...work }, personal: { ...personal } } };
  } catch {
    throw new Error(`Cannot read model defaults from ${modelDefaultsPath(agentDir)}.`);
  }
}

export function readProfileDefault(agentDir: string, profile: ProfileName): ModelEffortPreference {
  return readModelDefaults(agentDir).profiles[profile];
}

export function writeModelDefaults(agentDir: string, defaults: ModelDefaults): void {
  const path = modelDefaultsPath(agentDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, path);
}

export function writeProfileDefault(agentDir: string, profile: ProfileName, preference: ModelEffortPreference): void {
  if (!isPreference(preference)) throw new Error("Invalid model/effort preference.");
  const defaults = readModelDefaults(agentDir);
  defaults.profiles[profile] = { ...preference };
  writeModelDefaults(agentDir, defaults);
}

/** Redirect Pi's global model/thinking defaults to the active profile's complete pair. */
export function installProfileDefaultsPolicy(target: SettingsTarget, nextState: SettingsPolicyState): void {
  const patched = target as SettingsTarget & { [settingsMarker]?: SettingsPolicyState };
  const existing = patched[settingsMarker];
  if (existing) {
    existing.getProfile = nextState.getProfile;
    existing.getPreference = nextState.getPreference;
    existing.savePreference = nextState.savePreference;
    return;
  }

  const state = { ...nextState };
  const current = () => state.getPreference(state.getProfile());
  const update = (change: Partial<ModelEffortPreference>) => {
    const profile = state.getProfile();
    state.savePreference(profile, { ...state.getPreference(profile), ...change });
  };

  target.getDefaultProvider = () => current().provider;
  target.getDefaultModel = () => current().model;
  target.getDefaultThinkingLevel = () => current().thinking;
  target.setDefaultProvider = (provider) => update({ provider });
  target.setDefaultModel = (model) => update({ model });
  target.setDefaultModelAndProvider = (provider, model) => update({ provider, model });
  target.setDefaultThinkingLevel = (thinking) => update({ thinking });
  patched[settingsMarker] = state;
}

export const _test = { isPreference };
