import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentSession, InteractiveMode, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  bindRuntimeProfile,
  ensureProfileFiles,
  importMissingAccountKey,
  type ProfileName,
  profileAuthPath,
  runtimeStore,
} from "../shared/accounts.js";
import { installModelEffortPicker, type OpenModelEffortPicker } from "./picker.js";
import { installModelPolicy, installScopedModelPolicy } from "./policy.js";
import { installProfileDefaultsPolicy, type ModelEffortPreference } from "./preferences.js";

const startupBindingMarker = Symbol.for("pi.model-control.startup-binding");
type RefreshOptions = { providers?: string[]; allowNetwork?: boolean; signal?: AbortSignal };
type StartupBindingState = { agentDir: string; profile: () => ProfileName };
type RefreshTarget = {
  refresh?: (this: ModelRuntime, options?: RefreshOptions) => Promise<unknown>;
  [startupBindingMarker]?: StartupBindingState;
};

/** Bind credentials and seed a managed key before Pi's awaited initial catalog refresh. */
export function installStartupProfileBinding(
  agentDir: string,
  profile: () => ProfileName,
  target: RefreshTarget = ModelRuntime.prototype,
): void {
  const existing = target[startupBindingMarker];
  if (existing) {
    existing.agentDir = agentDir;
    existing.profile = profile;
    return;
  }
  const refresh = target.refresh;
  if (typeof refresh !== "function") throw new Error("Pi's ModelRuntime.refresh API changed; update model-control.");
  const state: StartupBindingState = { agentDir, profile };
  target.refresh = async function (this: ModelRuntime, options?: RefreshOptions) {
    try {
      ensureProfileFiles(state.agentDir);
      const wanted = state.profile();
      const store = runtimeStore(this);
      if (store.authPath && basename(store.authPath) === "auth.json") bindRuntimeProfile(this, state.agentDir, wanted);
      if (runtimeStore(this).authPath === profileAuthPath(state.agentDir, wanted)) {
        await importMissingAccountKey(this, state.agentDir, wanted);
      }
    } catch {
      // Credential bootstrap failures are surfaced later by normal model selection.
    }
    return refresh.call(this, options);
  };
  target[startupBindingMarker] = state;
}

/** Install every Pi prototype adapter once while replacing reload-sensitive callbacks. */
export function installRuntimeAdapters(options: {
  agentDir: string;
  getProfile: () => ProfileName;
  getPreference: (profile: ProfileName) => ModelEffortPreference;
  savePreference: (profile: ProfileName, preference: ModelEffortPreference) => void;
  openPicker: (ctx: ExtensionContext, initialSearchInput?: string) => Promise<void> | void;
}): void {
  installModelPolicy(ModelRuntime.prototype, options.getProfile);
  installScopedModelPolicy(AgentSession.prototype);
  installProfileDefaultsPolicy(SettingsManager.prototype, {
    getProfile: options.getProfile,
    getPreference: options.getPreference,
    savePreference: options.savePreference,
  });
  installStartupProfileBinding(options.agentDir, options.getProfile);
  installModelEffortPicker(InteractiveMode.prototype as never, options.openPicker as OpenModelEffortPicker);
}
