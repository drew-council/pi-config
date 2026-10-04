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
const serialRefreshMarker = Symbol.for("pi.model-control.serial-refresh");
type RefreshOptions = { providers?: string[]; allowNetwork?: boolean; signal?: AbortSignal };
type StartupBindingState = { agentDir: string; profile: () => ProfileName };
type RefreshTarget = {
  refresh?: (this: ModelRuntime, options?: RefreshOptions) => Promise<unknown>;
  [startupBindingMarker]?: StartupBindingState;
  [serialRefreshMarker]?: true;
};

// A refresh that has waited this long is treated as wedged rather than blocking
// every later refresh for the rest of the session.
const QUEUE_WAIT_LIMIT_MS = 30_000;

async function waitForTurn(previous: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUEUE_WAIT_LIMIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run each runtime's catalog refreshes one at a time.
 *
 * Pi numbers availability passes and discards any pass whose number was
 * superseded while it ran, so overlapping refreshes drop all but the
 * last-queued one. `registerProvider`, `registerNativeProvider` and
 * `registerVirtualModel` each start an unawaited `refresh()`, and extension
 * provider registration happens immediately before the awaited refresh that
 * ends Pi's service construction. That awaited refresh therefore routinely
 * loses its own pass and resolves while the snapshot still holds the
 * pre-extension catalog, which here is the one read before credentials were
 * rebound from auth.json to the active profile. Initial model selection then
 * sees an empty catalog: Pi warns "No models available", a resumed session's
 * model cannot be restored, and this profile's default never applies, until the
 * orphaned pass lands a moment later and the picker shows every model again.
 *
 * Serializing refreshes keeps each pass the newest one while it runs, so a
 * resolved `refresh()` always means its own results reached the snapshot.
 */
export function installSerialRefresh(target: RefreshTarget = ModelRuntime.prototype): void {
  if (target[serialRefreshMarker]) return;
  const refresh = target.refresh;
  if (typeof refresh !== "function") throw new Error("Pi's ModelRuntime.refresh API changed; update model-control.");
  // Per runtime: a subagent session can hold its own registry, and queueing its
  // refreshes behind an unrelated runtime's would serialize whole sessions.
  const queues = new WeakMap<object, Promise<void>>();
  target.refresh = async function (this: ModelRuntime, options?: RefreshOptions) {
    const previous = queues.get(this);
    const result = (previous ? waitForTurn(previous) : Promise.resolve()).then(() => refresh.call(this, options));
    queues.set(
      this,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  };
  target[serialRefreshMarker] = true;
}

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
  // After the binding wrapper, so credential rebinding and the refresh it
  // guards are serialized together as one unit.
  installSerialRefresh();
  installModelEffortPicker(InteractiveMode.prototype as never, options.openPicker as OpenModelEffortPicker);
}
