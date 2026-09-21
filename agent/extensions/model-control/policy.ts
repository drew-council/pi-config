import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ProfileName, providerAllowed } from "../shared/accounts.js";

/** Models matching any expression are unavailable everywhere, not merely hidden from the picker. */
export const MODEL_BLACKLIST = [
  /gemini-(?!(?:3\.[89]|[4-9]\.\d))/i,
  /^gemma-/i,
  /^deep-research-/i,
  /^grok-(?:[0-3](?:\.\d+)?|4(?:\.[0-4])?(?:$|-))/i,
  /^gpt-(?:[0-4](?:\.\d+)?|5(?:\.[0-5])?(?:$|-))/i,
  /^claude-(?:(?:opus|sonnet|haiku|fable)-[0-4]|[0-4])(?:[-.]\d+)*(?:$|-)/i,
  /^openrouter\/(?!(?:z-ai\/glm-5\.3(?:-flash)?|deepseek\/deepseek-v4\.1-flash)$)/i,
  /^github-copilot\/(?!gpt-(?:5\.[6-9]|[6-9]))/i,
] satisfies readonly RegExp[];

type ModelLike = { provider: string; id: string; name?: string };

export function isBlacklisted(model: ModelLike, patterns: readonly RegExp[] = MODEL_BLACKLIST): boolean {
  const candidates = [model.id, `${model.provider}/${model.id}`, model.name].filter((value): value is string =>
    Boolean(value),
  );
  return patterns.some((pattern) =>
    candidates.some((candidate) => {
      pattern.lastIndex = 0;
      return pattern.test(candidate);
    }),
  );
}

export function filterModels<T extends ModelLike>(
  models: readonly T[],
  profile: ProfileName,
  patterns: readonly RegExp[] = MODEL_BLACKLIST,
): T[] {
  return models.filter((model) => providerAllowed(profile, model.provider) && !isBlacklisted(model, patterns));
}

type PolicyTarget = Pick<
  ModelRuntime,
  | "getAvailableSnapshot"
  | "getAvailable"
  | "getModels"
  | "getModel"
  | "hasConfiguredAuth"
  | "checkAuth"
  | "getAuth"
  | "login"
>;
const policyMarker = Symbol.for("pi.model-control.policy");
const legacyProfileMarker = Symbol.for("pi.auth-profile.policy");
const legacyBlacklistMarker = Symbol.for("pi.model-blacklist.patch-installed");
type PolicyState = { profile: () => ProfileName; patterns: readonly RegExp[] };
type LegacyPolicyState = { profile: () => ProfileName };
type LegacyBlacklistState = { patterns: readonly RegExp[] };

/** A single reload-safe visibility/auth policy for profiles and the model blacklist. */
export function installModelPolicy(
  target: PolicyTarget,
  profile: () => ProfileName,
  patterns: readonly RegExp[] = MODEL_BLACKLIST,
): void {
  const patched = target as PolicyTarget & {
    [policyMarker]?: PolicyState;
    [legacyProfileMarker]?: LegacyPolicyState;
    [legacyBlacklistMarker]?: LegacyBlacklistState;
  };
  // A live /reload can retain wrappers from the extensions this one replaces.
  // Point those wrappers at the new state so they cannot freeze the old profile.
  if (patched[legacyProfileMarker]) patched[legacyProfileMarker].profile = profile;
  if (patched[legacyBlacklistMarker]) patched[legacyBlacklistMarker].patterns = patterns;
  if (patched[policyMarker]) {
    patched[policyMarker].profile = profile;
    patched[policyMarker].patterns = patterns;
    return;
  }
  const state: PolicyState = { profile, patterns };
  const visible = (model: ModelLike) =>
    providerAllowed(state.profile(), model.provider) && !isBlacklisted(model, state.patterns);
  const providerVisible = (provider: string) => providerAllowed(state.profile(), provider);
  const filter = <T extends ModelLike>(models: readonly T[]) => models.filter(visible);

  const snapshot = target.getAvailableSnapshot;
  const available = target.getAvailable;
  const models = target.getModels;
  const model = target.getModel;
  const configured = target.hasConfiguredAuth;
  const check = target.checkAuth;
  const auth = target.getAuth;
  const login = target.login;

  target.getAvailableSnapshot = function () {
    return filter(snapshot.call(this));
  };
  target.getAvailable = async function (provider, options) {
    if (provider && !providerVisible(provider)) return [];
    return filter(await available.call(this, provider, options));
  };
  target.getModels = function (provider) {
    if (provider && !providerVisible(provider)) return [];
    return filter(models.call(this, provider));
  };
  target.getModel = function (provider, id) {
    if (!providerVisible(provider)) return undefined;
    const found = model.call(this, provider, id);
    return found && visible(found) ? found : undefined;
  };
  target.hasConfiguredAuth = function (provider) {
    return providerVisible(provider) && configured.call(this, provider);
  };
  target.checkAuth = async function (provider, options) {
    return providerVisible(provider) ? check.call(this, provider, options) : undefined;
  };
  target.getAuth = async function (modelOrProvider: string | Model<Api>, options) {
    const provider = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider;
    if (!providerVisible(provider)) {
      throw new Error(`${provider} is disabled in the ${state.profile()} profile. Use /profile or /log-me-in.`);
    }
    if (typeof modelOrProvider !== "string" && !visible(modelOrProvider)) {
      throw new Error(`${modelOrProvider.provider}/${modelOrProvider.id} is unavailable by model policy.`);
    }
    return auth.call(this, modelOrProvider as Model<Api>, options);
  };
  target.login = async function (provider, type, interaction) {
    if (!providerVisible(provider)) throw new Error(`Use /profile before logging into ${provider}.`);
    return login.call(this, provider, type, interaction);
  };
  patched[policyMarker] = state;
}

const scopeMarker = Symbol.for("pi.model-control.scope-policy");
const legacyScopeMarker = Symbol.for("pi.auth-profile.scope-policy");
/** Scoped picker/autocomplete entries otherwise bypass the visible runtime snapshot. */
export function installScopedModelPolicy(proto: AgentSession): void {
  const target = proto as AgentSession & { [scopeMarker]?: boolean; [legacyScopeMarker]?: boolean };
  if (target[scopeMarker]) return;
  // The legacy wrapper already delegates visibility to ModelRuntime, whose
  // callback was updated above. Re-wrapping it only makes cycling harder to reason about.
  if (target[legacyScopeMarker]) {
    target[scopeMarker] = true;
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(proto, "scopedModels");
  const getter = descriptor?.get;
  const cycle = proto.cycleModel;
  type CycleInternals = { _cycleAvailableModel: AgentSession["cycleModel"] };
  if (!getter || typeof (proto as unknown as CycleInternals)._cycleAvailableModel !== "function") {
    throw new Error("Pi's scoped-model API changed; update model-control.");
  }
  Object.defineProperty(proto, "scopedModels", {
    ...descriptor,
    get(this: AgentSession) {
      const available = new Set(
        this.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`),
      );
      return (getter.call(this) as AgentSession["scopedModels"]).filter(({ model }) =>
        available.has(`${model.provider}/${model.id}`),
      );
    },
  });
  proto.cycleModel = function (direction = "forward", options = {}) {
    if (this.scopedModels.length === 0) {
      return (this as unknown as CycleInternals)._cycleAvailableModel(direction, options);
    }
    return cycle.call(this, direction, options);
  };
  target[scopeMarker] = true;
}

export const _test = { filterModels, installModelPolicy, isBlacklisted };
