import assert from "node:assert/strict";
import test from "node:test";
import { _test } from "../../extensions/model-control/policy.js";

const blacklistOnly = <T extends { provider: string; id: string; name?: string }>(models: readonly T[]) =>
  models.filter((model) => !_test.isBlacklisted(model));

test("model blacklist removes requested families and version ranges", () => {
  const models = [
    { provider: "google", id: "gemini-3-flash" },
    { provider: "google", id: "gemma-4-31b-it" },
    { provider: "google", id: "deep-research-preview" },
    { provider: "grok-cli", id: "grok-4.3" },
    { provider: "grok-cli", id: "grok-4.5" },
    { provider: "grok-cli", id: "grok-composer-2.5-fast" },
    { provider: "openai-codex", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];

  assert.deepEqual(
    blacklistOnly(models).map((model) => model.id),
    ["grok-4.5", "grok-composer-2.5-fast", "gpt-5.6-luna"],
  );
});

test("model blacklist removes claude models below major version 5", () => {
  const models = [
    { provider: "claude-bridge", id: "claude-fable-5" },
    { provider: "claude-bridge", id: "claude-opus-5" },
    { provider: "claude-bridge", id: "claude-sonnet-5" },
    { provider: "claude-bridge", id: "claude-opus-4-8" },
    { provider: "claude-bridge", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
  ];

  assert.deepEqual(
    blacklistOnly(models).map((model) => model.id),
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
  );
});

test("model blacklist exposes only approved OpenRouter models", () => {
  const models = [
    { provider: "openrouter", id: "anthropic/claude-opus-4.1" },
    { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
    { provider: "openrouter", id: "z-ai/glm-5.3" },
    { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
    { provider: "openrouter", id: "deepseek/deepseek-v4-flash" },
    { provider: "openrouter", id: "z-ai/glm-4.6" },
    { provider: "z-ai", id: "glm-5.3-flash" },
  ];

  assert.deepEqual(
    blacklistOnly(models).map((model) => `${model.provider}/${model.id}`),
    [
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/z-ai/glm-5.3",
      "openrouter/deepseek/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
    ],
  );
});

test("blacklist patterns also match provider-qualified ids and display names", () => {
  const patterns = [/^vendor\/hidden$/i, /^Friendly hidden$/i];
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly visible" }, patterns), false);
});

test("a live reload updates callbacks retained by the replaced policy wrappers", () => {
  const legacyProfile = Symbol.for("pi.auth-profile.policy");
  const legacyBlacklist = Symbol.for("pi.model-blacklist.patch-installed");
  const target = {
    getAvailableSnapshot: () => [],
    getAvailable: async () => [],
    getModels: () => [],
    getModel: () => undefined,
    hasConfiguredAuth: () => false,
    checkAuth: async () => undefined,
    getAuth: async () => undefined,
    login: async () => {},
    [legacyProfile]: { profile: () => "work" as const },
    [legacyBlacklist]: { patterns: [] as readonly RegExp[] },
  };
  const patterns = [/updated/];
  _test.installModelPolicy(
    target as unknown as Parameters<typeof _test.installModelPolicy>[0],
    () => "personal",
    patterns,
  );
  assert.equal(target[legacyProfile].profile(), "personal");
  assert.equal(target[legacyBlacklist].patterns, patterns);
});

test("the unified filter applies profile visibility and blacklist rules together", () => {
  const models = [
    { provider: "google-vertex", id: "gemini-3-flash" },
    { provider: "google-vertex", id: "gemini-3.8-flash" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];
  assert.deepEqual(
    _test.filterModels(models, "work").map((model) => model.id),
    ["gemini-3.8-flash"],
  );
  assert.deepEqual(
    _test.filterModels(models, "personal").map((model) => model.id),
    ["gemini-3.8-flash", "gpt-5.6-luna"],
  );
});
