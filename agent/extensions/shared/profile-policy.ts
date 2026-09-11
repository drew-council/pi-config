import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ProfileName, providerAllowed } from "./accounts.js";

type PolicyTarget = Pick<
  ModelRuntime,
  "getAvailableSnapshot" | "getAvailable" | "hasConfiguredAuth" | "checkAuth" | "getAuth" | "login"
>;
const marker = Symbol.for("pi.auth-profile.policy");
type PolicyState = { profile: () => ProfileName };

/** One reload-safe policy for the native picker, cycling, explicit selection and requests. */
export function installProfilePolicy(target: PolicyTarget, profile: () => ProfileName): void {
  const patched = target as PolicyTarget & { [marker]?: PolicyState };
  if (patched[marker]) {
    patched[marker].profile = profile;
    return;
  }
  const state: PolicyState = { profile };
  const allowed = (provider: string) => providerAllowed(state.profile(), provider);
  const filter = (models: readonly Model<Api>[]) => models.filter((model) => allowed(model.provider));
  const snapshot = target.getAvailableSnapshot;
  const available = target.getAvailable;
  const configured = target.hasConfiguredAuth;
  const check = target.checkAuth;
  const auth = target.getAuth;
  const login = target.login;
  target.getAvailableSnapshot = function () {
    return filter(snapshot.call(this));
  };
  target.getAvailable = async function (provider, options) {
    if (provider && !allowed(provider)) return [];
    return filter(await available.call(this, provider, options));
  };
  target.hasConfiguredAuth = function (provider) {
    return allowed(provider) && configured.call(this, provider);
  };
  target.checkAuth = async function (provider, options) {
    return allowed(provider) ? check.call(this, provider, options) : undefined;
  };
  target.getAuth = async function (model: string | Model<Api>, options) {
    const provider = typeof model === "string" ? model : model.provider;
    if (!allowed(provider))
      throw new Error(`${provider} is disabled in the ${state.profile()} profile. Use /profile or /log-me-in.`);
    // getAuth's overloads share the same implementation.
    return auth.call(this, model as Model<Api>, options);
  };
  target.login = async function (provider, type, interaction) {
    if (!allowed(provider)) throw new Error(`Use /profile before logging into ${provider}.`);
    return login.call(this, provider, type, interaction);
  };
  patched[marker] = state;
}

const scopeMarker = Symbol.for("pi.auth-profile.scope-policy");
/** Pi's scoped picker/autocomplete otherwise bypasses the available-model snapshot. */
export function installScopedModelPolicy(proto: AgentSession): void {
  const target = proto as AgentSession & { [scopeMarker]?: boolean };
  if (target[scopeMarker]) return;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "scopedModels");
  const getter = descriptor?.get;
  const cycle = proto.cycleModel;
  type CycleInternals = { _cycleAvailableModel: AgentSession["cycleModel"] };
  if (!getter || typeof (proto as unknown as CycleInternals)._cycleAvailableModel !== "function") {
    throw new Error("Pi's scoped-model API changed; update the profile adapter.");
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
    // A personal-only --models scope must not make work cycling unusable.
    if (this.scopedModels.length === 0) {
      return (this as unknown as CycleInternals)._cycleAvailableModel(direction, options);
    }
    return cycle.call(this, direction, options);
  };
  target[scopeMarker] = true;
}
