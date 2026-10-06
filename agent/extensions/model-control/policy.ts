import type { AnyModel } from "@earendil-works/pi-ai";
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

type ModelLike = { provider: string; id: string; name?: string; type?: string };

/** Non-chat capabilities remain disabled until explicitly authorized, in both profiles. */
export const NON_CHAT_ALLOWLISTS: Record<ProfileName, Record<"classifier" | "image", readonly string[]>> = {
  work: { classifier: [], image: [] },
  personal: { classifier: [], image: [] },
};

export function modelAllowed(
  model: ModelLike,
  profile: ProfileName,
  patterns: readonly RegExp[] = MODEL_BLACKLIST,
): boolean {
  if (!providerAllowed(profile, model.provider)) return false;
  const type = model.type ?? "chat";
  if (type === "chat") return !isBlacklisted(model, patterns);
  if (type !== "classifier" && type !== "image") return false;
  return NON_CHAT_ALLOWLISTS[profile][type].includes(`${model.provider}/${model.id}`);
}

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
  return models.filter((model) => modelAllowed(model, profile, patterns));
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
  | "getModelsOfType"
  | "getModelOfType"
  | "getAvailableOfType"
  | "getAllModels"
  | "getAllAvailable"
  | "classify"
  | "generateImages"
>;
const typedPolicyMarker = Symbol.for("pi.model-control.typed-policy");

/** Separate marker also installs these guards when /reload retains older chat-only wrappers. */
function installTypedModelPolicy(target: PolicyTarget, profile: () => ProfileName, patterns: readonly RegExp[]): void {
  const patched = target as PolicyTarget & { [typedPolicyMarker]?: PolicyState };
  const existing = patched[typedPolicyMarker];
  if (existing) {
    existing.profile = profile;
    existing.patterns = patterns;
    return;
  }
  const state: PolicyState = { profile, patterns };
  const visible = (model: ModelLike) => modelAllowed(model, state.profile(), state.patterns);
  const allowedType = (type: string, provider?: string) =>
    (type === "chat" ||
      ((type === "image" || type === "classifier") && NON_CHAT_ALLOWLISTS[state.profile()][type].length > 0)) &&
    (!provider || providerAllowed(state.profile(), provider));
  const models = target.getModelsOfType;
  const model = target.getModelOfType;
  const available = target.getAvailableOfType;
  const allModels = target.getAllModels;
  const allAvailable = target.getAllAvailable;
  const classify = target.classify;
  const images = target.generateImages;
  const auth = target.getAuth;

  target.getAuth = async function (modelOrProvider: string | AnyModel, options) {
    if (typeof modelOrProvider !== "string" && !visible(modelOrProvider)) {
      throw new Error(`${modelOrProvider.provider}/${modelOrProvider.id} is unavailable by model policy.`);
    }
    return auth.call(this, modelOrProvider as AnyModel, options);
  };
  target.getModelsOfType = function (type, provider) {
    if (!allowedType(type, provider)) return [];
    return models.call(this, type, provider).filter((entry) => visible({ ...entry, type }));
  };
  target.getModelOfType = function (type, provider, id) {
    if (!allowedType(type, provider)) return undefined;
    const found = model.call(this, type, provider, id);
    return found && visible({ ...found, type }) ? found : undefined;
  };
  target.getAvailableOfType = async function (type, provider, options) {
    if (!allowedType(type, provider)) return [];
    return (await available.call(this, type, provider, options)).filter((entry) => visible({ ...entry, type }));
  };
  target.getAllModels = function (provider) {
    if (provider && !providerAllowed(state.profile(), provider)) return [];
    return allModels.call(this, provider).filter(visible);
  };
  target.getAllAvailable = async function (provider, options) {
    if (provider && !providerAllowed(state.profile(), provider)) return [];
    return (await allAvailable.call(this, provider, options)).filter(visible);
  };
  target.classify = async function (entry, context, options) {
    // Authorize the operation, not the caller-supplied discriminant or a prior discovery result.
    if (!visible({ ...entry, type: "classifier" })) {
      return {
        api: entry.api,
        provider: entry.provider,
        model: entry.id,
        answers: {},
        timestamp: Date.now(),
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: `${entry.provider}/${entry.id} is unavailable by classifier model policy.`,
      };
    }
    return classify.call(this, entry, context, options);
  };
  target.generateImages = async function (entry, context, options) {
    if (!visible({ ...entry, type: "image" })) {
      return {
        api: entry.api,
        provider: entry.provider,
        model: entry.id,
        output: [],
        timestamp: Date.now(),
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: `${entry.provider}/${entry.id} is unavailable by image model policy.`,
      };
    }
    return images.call(this, entry, context, options);
  };
  patched[typedPolicyMarker] = state;
}

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
  installTypedModelPolicy(target, profile, patterns);
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
  const visible = (model: ModelLike) => modelAllowed(model, state.profile(), state.patterns);
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
  target.getAuth = async function (modelOrProvider: string | AnyModel, options) {
    const provider = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider;
    if (!providerVisible(provider)) {
      throw new Error(`${provider} is disabled in the ${state.profile()} profile. Use /profile or /log-me-in.`);
    }
    if (typeof modelOrProvider !== "string" && !visible(modelOrProvider)) {
      throw new Error(`${modelOrProvider.provider}/${modelOrProvider.id} is unavailable by model policy.`);
    }
    return auth.call(this, modelOrProvider as AnyModel, options);
  };
  target.login = async function (...args) {
    const [provider] = args;
    if (!providerVisible(provider)) throw new Error(`Use /profile before logging into ${provider}.`);
    return login.apply(this, args);
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
