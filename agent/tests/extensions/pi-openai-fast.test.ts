import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piOpenAIFast, { _test } from "../../extensions/pi-openai-fast/index.js";

test("fast-model support is exact and payload updates are immutable", () => {
  const configured = [{ provider: "custom", id: "priority-deployment" }];

  assert.equal(_test.isFastSupportedModel({ provider: "openai", id: "gpt-5" } as never, configured), true);
  assert.equal(_test.isFastSupportedModel({ provider: "openai-codex", id: "gpt-5.2-pro" } as never, configured), false);
  assert.equal(_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.2-preview" } as never, configured), false);
  assert.equal(
    _test.isFastSupportedModel({ provider: "custom", id: "priority-deployment" } as never, configured),
    true,
  );
  assert.equal(_test.isFastSupportedModel({ provider: "custom", id: "other" } as never, configured), false);

  const payload = { model: "gpt-5", service_tier: "default", nested: { keep: true } };
  const updated = _test.applyFastServiceTier(payload);
  assert.deepEqual(updated, { model: "gpt-5", service_tier: "priority", nested: { keep: true } });
  assert.notEqual(updated, payload);
  assert.equal(payload.service_tier, "default");
  assert.equal(_test.applyFastServiceTier("raw body"), "raw body");
});

test("project fast config overrides global state while retaining unspecified global settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-fast-config-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const { projectConfigPath, globalConfigPath } = _test.getConfigPaths(cwd, home);

  try {
    await mkdir(path.dirname(projectConfigPath), { recursive: true });
    await mkdir(path.dirname(globalConfigPath), { recursive: true });
    await writeFile(
      globalConfigPath,
      `${JSON.stringify({ active: true, persistState: false, supportedModels: ["custom/fast", "invalid"] })}\n`,
    );
    await writeFile(projectConfigPath, `${JSON.stringify({ active: false })}\n`);

    assert.deepEqual(_test.resolveFastConfig(cwd, home), {
      configPath: projectConfigPath,
      persistState: false,
      active: false,
      supportedModels: [{ provider: "custom", id: "fast" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active fast mode applies priority only to supported provider requests and persists command changes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-fast-extension-"));
  const configPath = path.join(cwd, ".pi", "extensions", _test.FAST_CONFIG_BASENAME);
  const handlers = new Map<string, (event: unknown, ctx: TestContext) => unknown>();
  let fastCommand: { handler(args: string, ctx: TestContext): Promise<void> } | undefined;

  type TestContext = {
    cwd: string;
    model: { provider: string; id: string } | undefined;
    ui: { notify(message: string, level: string): void };
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    registerFlag() {},
    registerCommand(name: string, command: typeof fastCommand) {
      if (name === "fast") fastCommand = command;
    },
    on(event: string, handler: (event: unknown, ctx: TestContext) => unknown) {
      handlers.set(event, handler);
    },
    getFlag() {
      return false;
    },
  };

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ active: true, persistState: true, supportedModels: ["custom/priority-model"] })}\n`,
    );
    piOpenAIFast(pi as unknown as ExtensionAPI);

    const ctx: TestContext = {
      cwd,
      model: { provider: "custom", id: "priority-model" },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    };
    const sessionStart = handlers.get("session_start");
    const beforeRequest = handlers.get("before_provider_request");
    assert.ok(sessionStart);
    assert.ok(beforeRequest);
    assert.ok(fastCommand);

    await sessionStart({}, ctx);
    const originalPayload = { model: "priority-model", metadata: { requestId: "abc" } };
    assert.deepEqual(beforeRequest({ payload: originalPayload }, ctx), {
      model: "priority-model",
      metadata: { requestId: "abc" },
      service_tier: "priority",
    });
    assert.deepEqual(originalPayload, { model: "priority-model", metadata: { requestId: "abc" } });

    ctx.model = { provider: "custom", id: "unsupported" };
    assert.equal(beforeRequest({ payload: originalPayload }, ctx), undefined);

    await fastCommand.handler("off", ctx);
    ctx.model = { provider: "custom", id: "priority-model" };
    assert.equal(beforeRequest({ payload: originalPayload }, ctx), undefined);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).active, false);
    assert.match(notifications.at(-1)?.message ?? "", /disabled/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
