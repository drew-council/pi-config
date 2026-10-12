import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, InteractiveMode, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { installCommandGuard, installRuntimeGuard, makeEphemeral } from "../../extensions/pii-mode/guards.js";
import { registerPiiMode } from "../../extensions/pii-mode/index.js";
import { DEFAULT_CONFIG, modelAllowed, readConfig } from "../../extensions/pii-mode/policy.js";
import { PROMPT_SECTION } from "../../extensions/pii-mode/prompt.js";
import { PII_ENV, piiState, removeStaleScratchDirs } from "../../extensions/pii-mode/state.js";

const directories: string[] = [];
const scratch = (prefix = "pi-pii-test-") => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

let savedTmpDir: string | undefined;
beforeEach(() => {
  savedTmpDir = process.env.TMPDIR;
  delete process.env[PII_ENV];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi.pii-mode.state")];
});
afterEach(() => {
  const leftover = piiState().scratchDir;
  if (leftover) rmSync(leftover, { recursive: true, force: true });
  delete process.env[PII_ENV];
  if (savedTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpDir;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi.pii-mode.state")];
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixtureModel = (provider: string, id: string): Model<Api> => ({
  provider,
  id,
  name: id,
  api: "anthropic-messages",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1024,
});
const vertex = fixtureModel("google-vertex", "gemini-3.8-flash");
const claude = fixtureModel("claude-bridge", "claude-opus-5-5");

test("only allowed chat models pass the policy", () => {
  expect(modelAllowed(DEFAULT_CONFIG, vertex)).toBeTrue();
  expect(modelAllowed(DEFAULT_CONFIG, claude)).toBeFalse();
  expect(modelAllowed(DEFAULT_CONFIG, { provider: "google", id: "gemini-3.8-flash" })).toBeFalse();
  expect(modelAllowed(DEFAULT_CONFIG, { ...vertex, type: "classifier" })).toBeFalse();
  expect(modelAllowed(DEFAULT_CONFIG, undefined)).toBeFalse();
});

test("configuration overrides defaults key by key and rejects invalid input", () => {
  const agentDir = scratch();
  expect(readConfig(agentDir)).toEqual(DEFAULT_CONFIG);
  writeFileSync(join(agentDir, "pii-mode.json"), JSON.stringify({ allowedTools: ["read"] }));
  expect(readConfig(agentDir)).toEqual({ ...DEFAULT_CONFIG, allowedTools: ["read"] });
  writeFileSync(join(agentDir, "pii-mode.json"), JSON.stringify({ models: [{ provider: "x", id: "(" }] }));
  expect(() => readConfig(agentDir)).toThrow();
  writeFileSync(join(agentDir, "pii-mode.json"), "{");
  expect(() => readConfig(agentDir)).toThrow("not valid JSON");
});

test("pi still exposes every internal the guards wrap", () => {
  expect(installRuntimeGuard(Object.create(ModelRuntime.prototype))).toEqual([]);
  expect(installCommandGuard(Object.create(InteractiveMode.prototype))).toEqual([]);
  const sessionManager = SessionManager.inMemory(scratch());
  expect(typeof (sessionManager as unknown as { persist: unknown }).persist).toBe("boolean");
});

async function offlineRuntime() {
  const directory = scratch();
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  (runtime as unknown as { defaultBuiltins: Map<string, Provider> }).defaultBuiltins.clear();
  const reached: string[] = [];
  for (const model of [vertex, claude]) {
    runtime.registerNativeProvider({
      id: model.provider,
      name: "Offline fixture",
      getModels: () => [model],
      auth: { apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: "fixture-only" } }) } },
      stream: () => {
        throw new Error("unused");
      },
      streamSimple: () => {
        reached.push(model.provider);
        throw new Error("fixture provider reached");
      },
    });
  }
  await runtime.refresh({ allowNetwork: false });
  installRuntimeGuard(runtime as unknown as Record<string, unknown>);
  return { runtime, reached };
}

test("the request guard refuses other providers before they are reached, through pi's real request path", async () => {
  const { runtime, reached } = await offlineRuntime();
  const context = { messages: [{ role: "user" as const, content: "PII", timestamp: 0 }] };

  expect((await runtime.completeSimple(claude, context)).errorMessage).toBe("fixture provider reached");
  process.env[PII_ENV] = "1";
  const refused = await runtime.completeSimple(claude, context);
  expect(refused.stopReason).toBe("error");
  expect(refused.errorMessage).toContain("blocked in PII-safe mode");
  expect((await runtime.completeSimple(vertex, context)).errorMessage).toBe("fixture provider reached");
  expect(reached).toEqual(["claude-bridge", "google-vertex"]);

  expect(runtime.getAvailableSnapshot().map((model) => model.provider)).toEqual(["google-vertex"]);
  expect((await runtime.getAvailable()).map((model) => model.provider)).toEqual(["google-vertex"]);
  expect(await runtime.getAvailableOfType("classifier")).toEqual([]);
});

test("an ephemeral session never creates its file", () => {
  const sessionDir = scratch();
  const message = (role: "user" | "assistant") =>
    role === "user"
      ? { role, content: "PII", timestamp: 0 }
      : {
          role,
          content: [{ type: "text" as const, text: "PII" }],
          api: "anthropic-messages",
          provider: "google-vertex",
          model: "gemini-3.8-flash",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: 0,
        };

  const control = SessionManager.create(sessionDir, join(sessionDir, "control"));
  control.appendMessage(message("user"));
  expect(readdirSync(join(sessionDir, "control"))).toHaveLength(1);

  const ephemeral = SessionManager.create(sessionDir, join(sessionDir, "ephemeral"));
  makeEphemeral(ephemeral);
  ephemeral.appendMessage(message("user"));
  ephemeral.appendMessage(message("assistant"));
  expect(ephemeral.getEntries()).toHaveLength(2);
  expect(ephemeral.isPersisted()).toBeFalse();
  expect(ephemeral.getSessionFile()).toBeUndefined();
  expect(readdirSync(join(sessionDir, "ephemeral"))).toEqual([]);
});

test("transcript commands are refused only while active", async () => {
  const calls: string[] = [];
  const target = {
    handleShareCommand: async () => calls.push("share"),
    handleExportCommand: async () => calls.push("export"),
    handleBugCommand: async () => calls.push("bug"),
    showError: (message: string) => calls.push(message),
  };
  expect(installCommandGuard(target as unknown as Record<string, unknown>)).toEqual([]);
  await target.handleShareCommand();
  process.env[PII_ENV] = "1";
  await target.handleShareCommand();
  await target.handleExportCommand();
  await target.handleBugCommand();
  expect(calls).toEqual([
    "share",
    "/share is disabled in PII-safe mode.",
    "/export is disabled in PII-safe mode.",
    "/bug is disabled in PII-safe mode.",
  ]);
});

test("stale scratch directories of dead processes are removed", () => {
  const base = scratch();
  mkdirSync(join(base, "pi-pii-999999999-dead"));
  mkdirSync(join(base, `pi-pii-${process.pid}-alive`));
  mkdirSync(join(base, "unrelated"));
  removeStaleScratchDirs(base);
  expect(readdirSync(base).sort()).toEqual([`pi-pii-${process.pid}-alive`, "unrelated"]);
});

type Handler = (event: unknown, ctx: unknown) => unknown;
function harness(options: { conversation?: boolean; flag?: boolean; cancel?: boolean } = {}) {
  const directory = scratch();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  let activeTools = ["read", "bash", "codemode", "subagent", "web_search"];
  let shutdowns = 0;
  const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
  if (options.conversation) sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: 0 });
  const ctx = {
    hasUI: true,
    model: claude as Model<Api> | undefined,
    sessionManager,
    modelRegistry: {
      find: (provider: string, id: string) => [vertex, claude].find((m) => m.provider === provider && m.id === id),
      getAvailable: () => [claude, vertex],
      getAll: () => [claude, vertex],
    },
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
      confirm: async () => {
        throw new Error("/pii must not ask for confirmation");
      },
    },
    shutdown: () => {
      shutdowns += 1;
    },
    waitForIdle: async () => {},
    newSession: async () => {
      if (options.cancel) return { cancelled: true };
      await handlers.get("session_start")?.({ reason: "new" }, ctx);
      return { cancelled: false };
    },
  };
  const pi = {
    registerFlag: () => {},
    getFlag: () => options.flag ?? false,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, command),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    setModel: async (model: Model<Api>) => {
      ctx.model = model;
      return true;
    },
  } as unknown as ExtensionAPI;
  registerPiiMode(pi, { agentDir: directory });
  return {
    ctx,
    sessionManager,
    notices,
    statuses,
    activeTools: () => activeTools,
    shutdowns: () => shutdowns,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    run: (command: string) => commands.get(command)?.handler("", ctx),
  };
}

test("/pii starts a fresh in-memory session on an allowed model with a private TMPDIR", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  expect(h.sessionManager.isPersisted()).toBeTrue();

  await h.run("pii");
  expect(process.env[PII_ENV]).toBe("1");
  expect(h.sessionManager.isPersisted()).toBeFalse();
  expect(h.ctx.model).toBe(vertex);
  expect(h.activeTools()).toEqual(["read", "bash", "codemode"]);
  expect(h.statuses.get("pii-mode")).toBe("PII-safe");
  const scratchDir = piiState().scratchDir;
  expect(scratchDir && process.env.TMPDIR === scratchDir && existsSync(scratchDir)).toBeTrue();
  expect(statSync(scratchDir as string).mode & 0o777).toBe(0o700);

  await h.emit("session_shutdown", { reason: "new" });
  expect(existsSync(scratchDir as string)).toBeTrue();
  await h.emit("session_shutdown", { reason: "quit" });
  expect(existsSync(scratchDir as string)).toBeFalse();
  expect(process.env.TMPDIR).toBe(savedTmpDir);
});

test("a cancelled /pii leaves nothing behind", async () => {
  const h = harness({ cancel: true });
  await h.run("pii");
  expect(process.env[PII_ENV]).toBeUndefined();
  expect(piiState().scratchDir).toBeUndefined();
  expect(process.env.TMPDIR).toBe(savedTmpDir);
  expect(h.notices.at(-1)).toContain("was not entered");
});

test("--pii refuses to continue a saved conversation", async () => {
  const h = harness({ flag: true, conversation: true });
  await h.emit("session_start", { reason: "startup" });
  expect(h.shutdowns()).toBe(1);
  expect(h.notices.at(-1)).toContain("cannot continue a saved one");
});

test("while active: tools, session switches, model choice and the system prompt are restricted", async () => {
  const h = harness({ flag: true });
  await h.emit("session_start", { reason: "startup" });
  expect(h.sessionManager.isPersisted()).toBeFalse();

  expect(await h.emit("tool_call", { toolName: "read" })).toBeUndefined();
  expect(await h.emit("tool_call", { toolName: "composio_execute" })).toMatchObject({ block: true });
  expect(await h.emit("session_before_switch", { reason: "resume" })).toEqual({ cancel: true });
  expect(await h.emit("session_before_switch", { reason: "new" })).toBeUndefined();

  h.ctx.model = claude;
  await h.emit("model_select", { model: claude, previousModel: vertex });
  expect(h.ctx.model).toBe(vertex);

  const sections: Record<string, string> = {};
  await h.emit("before_agent_start", { systemPromptOptions: { sections } });
  expect(sections[PROMPT_SECTION]).toContain(piiState().scratchDir as string);
});

test("inactive sessions are untouched", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  expect(await h.emit("tool_call", { toolName: "subagent" })).toBeUndefined();
  expect(await h.emit("session_before_switch", { reason: "resume" })).toBeUndefined();
  expect(h.sessionManager.isPersisted()).toBeTrue();
  expect(h.ctx.model).toBe(claude);
});
