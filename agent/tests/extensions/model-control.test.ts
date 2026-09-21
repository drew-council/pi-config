import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  expandModelEffortPairs,
  filterModelEffortPairs,
  installModelEffortPicker,
  sortModelEffortPairs,
} from "../../extensions/model-control/picker.js";
import {
  installProfileDefaultsPolicy,
  type ModelEffortPreference,
  readModelDefaults,
  readProfileDefault,
  writeModelDefaults,
  writeProfileDefault,
} from "../../extensions/model-control/preferences.js";
import {
  appendModelUsage,
  createActualUseRecorder,
  pairKey,
  readRecentUsage,
} from "../../extensions/model-control/usage.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-model-control-"));
  directories.push(directory);
  return directory;
}
const model = (provider: string, id: string, reasoning: boolean, name?: string) =>
  ({ provider, id, reasoning, name }) as Model<Api>;

describe("profile defaults", () => {
  test("reads, writes, and preserves the other profile atomically", () => {
    const agentDir = fixture();
    writeModelDefaults(agentDir, {
      version: 1,
      profiles: {
        work: { provider: "claude-bridge", model: "claude-opus-5", thinking: "medium" },
        personal: { provider: "openrouter", model: "z-ai/glm-5.3-flash", thinking: "high" },
      },
    });
    expect(readProfileDefault(agentDir, "work")).toMatchObject({
      provider: "claude-bridge",
      model: "claude-opus-5",
      thinking: "medium",
    });
    const personal = readProfileDefault(agentDir, "personal");
    const changed: ModelEffortPreference = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
    writeProfileDefault(agentDir, "work", changed);
    expect(readProfileDefault(agentDir, "work")).toEqual(changed);
    expect(readProfileDefault(agentDir, "personal")).toEqual(personal);
    expect(readModelDefaults(agentDir).version).toBe(1);
  });

  test("SettingsManager defaults follow the active profile and setters update a complete pair", () => {
    let profile: "work" | "personal" = "work";
    const preferences: Record<"work" | "personal", ModelEffortPreference> = {
      work: { provider: "claude-bridge", model: "claude-opus-5", thinking: "medium" },
      personal: { provider: "openrouter", model: "z-ai/glm-5.3-flash", thinking: "high" },
    };
    const target: Parameters<typeof installProfileDefaultsPolicy>[0] = {
      getDefaultProvider: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultProvider: (_provider) => {},
      setDefaultModel: (_model) => {},
      setDefaultModelAndProvider: (_provider, _model) => {},
      getDefaultThinkingLevel: () => undefined,
      setDefaultThinkingLevel: (_thinking) => {},
    };
    const install = () =>
      installProfileDefaultsPolicy(target, {
        getProfile: () => profile,
        getPreference: (selected) => preferences[selected],
        savePreference: (selected, preference) => {
          preferences[selected] = preference;
        },
      });
    install();
    const patchedGetter = target.getDefaultModel;
    expect(target.getDefaultModel()).toBe("claude-opus-5");
    target.setDefaultThinkingLevel("high");
    expect(preferences.work).toEqual({ provider: "claude-bridge", model: "claude-opus-5", thinking: "high" });
    profile = "personal";
    expect(target.getDefaultProvider()).toBe("openrouter");
    target.setDefaultModelAndProvider("openai-codex", "gpt-5.6-luna");
    expect(preferences.personal).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" });
    install();
    expect(target.getDefaultModel).toBe(patchedGetter);
  });
});

describe("actual-use recency", () => {
  test("records only the first provider request after an agent message", () => {
    const agentDir = fixture();
    const opus = model("claude-bridge", "claude-opus-5", true);
    const recorder = createActualUseRecorder(
      agentDir,
      () => "work",
      () => 42,
    );
    expect(recorder.recordBeforeProvider({ model: opus, thinkingLevel: "high" })).toBeFalse();
    expect(readRecentUsage(agentDir, "work")).toEqual(new Map());
    recorder.markPending();
    expect(recorder.recordBeforeProvider({ model: opus, thinkingLevel: "high" })).toBeTrue();
    expect(recorder.recordBeforeProvider({ model: opus, thinkingLevel: "high" })).toBeFalse();
    expect(
      readRecentUsage(agentDir, "work").get(pairKey({ provider: opus.provider, model: opus.id, thinking: "high" })),
    ).toBe(42);
  });

  test("records complete pairs per profile and sorts unused pairs deterministically", () => {
    const agentDir = fixture();
    const older = { provider: "google", model: "gemini-3.8-flash", thinking: "high" as const };
    const newer = { provider: "claude-bridge", model: "claude-opus-5", thinking: "medium" as const };
    appendModelUsage(agentDir, { usedAt: 10, profile: "work", ...older });
    appendModelUsage(agentDir, { usedAt: 20, profile: "work", ...newer });
    appendModelUsage(agentDir, { usedAt: 30, profile: "personal", ...older });
    const recent = readRecentUsage(agentDir, "work");
    expect(recent.get(pairKey(newer))).toBe(20);
    expect(recent.get(pairKey(older))).toBe(10);
    const unused = { provider: "github-copilot", model: "gpt-5.6-luna", thinking: "low" as const };
    const pairs = [older, unused, newer].map((pair) => ({
      ...pair,
      modelObject: model(pair.provider, pair.model, true),
    }));
    expect(sortModelEffortPairs(pairs, recent).map(pairKey)).toEqual([pairKey(newer), pairKey(older), pairKey(unused)]);
  });
});

describe("combined picker data", () => {
  test("expands supported efforts, respects pinned scopes, and searches model plus effort", () => {
    const opus = model("claude-bridge", "claude-opus-5", true, "Claude Opus 5");
    const plain = model("google", "gemini-3.8-flash", false, "Gemini Flash");
    const pairs = expandModelEffortPairs([opus, plain]);
    expect(pairs.filter((pair) => pair.model === opus.id).map((pair) => pair.thinking)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(pairs.filter((pair) => pair.model === plain.id).map((pair) => pair.thinking)).toEqual(["off"]);
    expect(filterModelEffortPairs(pairs, "opus high").map((pair) => `${pair.model}:${pair.thinking}`)).toEqual([
      "claude-opus-5:high",
    ]);

    const scoped = [{ model: opus, thinkingLevel: "high" as const }];
    expect(expandModelEffortPairs([opus], scoped as ExtensionContext["scopedModels"])).toHaveLength(1);
  });

  test("routes both selector and /model search through one reload-safe hook", async () => {
    const calls: string[] = [];
    const ctx = {} as ExtensionContext;
    const target = {
      showModelSelector: (_search?: string) => {},
      handleModelCommand: async (_search?: string) => {},
    };
    const instance = {
      session: { extensionRunner: { createContext: () => ctx } },
    };
    installModelEffortPicker(target, (_context, search) => {
      calls.push(`first:${search ?? ""}`);
    });
    const wrapper = target.showModelSelector;
    target.showModelSelector.call(instance, "high");
    await Promise.resolve();
    installModelEffortPicker(target, (_context, search) => {
      calls.push(`second:${search ?? ""}`);
    });
    expect(target.showModelSelector).toBe(wrapper);
    await target.handleModelCommand.call(instance, "opus high");
    await Promise.resolve();
    expect(calls).toEqual(["first:high", "second:opus high"]);
  });
});
