import type { AnyModel } from "@earendil-works/pi-ai";
import { type ExtensionContext, InteractiveMode, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelAllowed } from "./policy.js";
import { isActive, piiState } from "./state.js";

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Patchable = Record<string | symbol, unknown>;

const visible = (model: AnyModel, type?: string) =>
  !isActive() || modelAllowed(piiState().config, { ...model, type: type ?? model.type });

/** Rejects a model request in PII-safe mode unless its model is allowed. */
export function assertRequestAllowed(model: AnyModel): void {
  if (visible(model)) return;
  throw new Error(`${model.provider}/${model.id} is blocked in PII-safe mode; only allowed models may receive data.`);
}

const runtimeMarker = Symbol.for("pi.pii-mode.runtime-guard");
const RUNTIME_METHODS = [
  "prepareRequest",
  "getAvailableSnapshot",
  "getAvailable",
  "getAllAvailable",
  "getAvailableOfType",
] as const;

/**
 * Every chat, deferred, classifier and image request (agent turns, compaction,
 * branch summaries, extension calls through ctx.modelRegistry) resolves its
 * provider and credentials in the private `prepareRequest`, so refusing there
 * fails closed however a model was selected. The availability filters keep
 * pickers, scoped models and cycling from offering anything else.
 */
export function installRuntimeGuard(target: Patchable = ModelRuntime.prototype as unknown as Patchable): string[] {
  if (target[runtimeMarker]) return [];
  const missing = RUNTIME_METHODS.filter((name) => typeof target[name] !== "function").map(
    (name) => `ModelRuntime.${name}`,
  );
  if (missing.length > 0) return missing;
  const [prepare, snapshot, available, allAvailable, availableOfType] = RUNTIME_METHODS.map(
    (name) => target[name] as Method,
  );
  target.prepareRequest = async function (this: unknown, model: AnyModel, ...rest: unknown[]) {
    assertRequestAllowed(model);
    return prepare.call(this, model, ...rest);
  };
  target.getAvailableSnapshot = function (this: unknown) {
    return (snapshot.call(this) as AnyModel[]).filter((model) => visible(model));
  };
  target.getAvailable = async function (this: unknown, ...args: unknown[]) {
    return ((await available.apply(this, args)) as AnyModel[]).filter((model) => visible(model));
  };
  target.getAllAvailable = async function (this: unknown, ...args: unknown[]) {
    return ((await allAvailable.apply(this, args)) as AnyModel[]).filter((model) => visible(model));
  };
  target.getAvailableOfType = async function (this: unknown, type: string, ...rest: unknown[]) {
    return ((await availableOfType.call(this, type, ...rest)) as AnyModel[]).filter((model) => visible(model, type));
  };
  target[runtimeMarker] = true;
  return [];
}

const commandMarker = Symbol.for("pi.pii-mode.command-guard");
// Built-in commands that upload or write the transcript. Pi handles them before
// the extension `input` event, so they can only be refused here.
const TRANSCRIPT_COMMANDS = {
  handleShareCommand: "/share",
  handleExportCommand: "/export",
  handleBugCommand: "/bug",
} as const;

export function installCommandGuard(target: Patchable = InteractiveMode.prototype as unknown as Patchable): string[] {
  if (target[commandMarker]) return [];
  const missing = [...Object.keys(TRANSCRIPT_COMMANDS), "showError"]
    .filter((name) => typeof target[name] !== "function")
    .map((name) => `InteractiveMode.${name}`);
  if (missing.length > 0) return missing;
  for (const [name, command] of Object.entries(TRANSCRIPT_COMMANDS)) {
    const original = target[name] as Method;
    target[name] = async function (this: { showError(message: string): void }, ...args: unknown[]) {
      if (isActive()) {
        this.showError(`${command} is disabled in PII-safe mode.`);
        return;
      }
      return original.apply(this, args);
    };
  }
  target[commandMarker] = true;
  return [];
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];
type SessionFileState = { persist?: unknown; sessionFile?: unknown };

export const sessionPersistenceKnown = (sessionManager: ReadonlySessionManager): boolean =>
  typeof (sessionManager as SessionFileState).persist === "boolean";

export const isPersisted = (sessionManager: ReadonlySessionManager): boolean =>
  (sessionManager as SessionFileState).persist === true;

/**
 * Stops writing this session to disk, exactly as `--no-session` does: every
 * SessionManager write checks `persist`. Pi then also creates later /new and
 * /fork sessions in memory, because it copies the outgoing session's mode.
 */
export function makeEphemeral(sessionManager: ReadonlySessionManager): void {
  if (!sessionPersistenceKnown(sessionManager)) {
    throw new Error("Pi's SessionManager no longer exposes `persist`; pii-mode cannot keep sessions off disk.");
  }
  const state = sessionManager as SessionFileState;
  state.persist = false;
  // No file path: nothing (PI_SESSION_FILE for bash, artifact directories) points at disk.
  state.sessionFile = undefined;
}

export const hasConversation = (sessionManager: ReadonlySessionManager): boolean =>
  sessionManager
    .getEntries()
    .some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
