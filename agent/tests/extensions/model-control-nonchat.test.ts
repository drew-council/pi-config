import { expect, test } from "bun:test";
import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installModelPolicy, modelAllowed, NON_CHAT_ALLOWLISTS } from "../../extensions/model-control/policy.js";
import type { ProfileName } from "../../extensions/shared/accounts.js";

const chat = { provider: "google-vertex", id: "gemini-3.8-flash", type: "chat" } as Model<Api>;
const personalChat = { provider: "openai", id: "gpt-6.1-sol", type: "chat" } as Model<Api>;
const classifier = {
  provider: "openrouter",
  id: "typesafe/jev-1.13",
  type: "classifier",
  api: "openrouter-classifier",
};
const image = { provider: "openrouter", id: "black-forest-labs/flux.2-pro", type: "image", api: "openrouter-images" };
const entries = [chat, personalChat, classifier, image];

function fixture(profile: ProfileName, retainedChatPolicy = false) {
  let current = profile;
  let calls = 0;
  const list = (provider?: string) => entries.filter((entry) => !provider || entry.provider === provider);
  const target = {
    getAvailableSnapshot: () => entries.filter((entry) => entry.type === "chat"),
    getModels: (provider?: string) => list(provider).filter((entry) => entry.type === "chat"),
    getModel: (provider: string, id: string) =>
      list(provider).find((entry) => entry.id === id && entry.type === "chat"),
    getAvailable: async (provider?: string) => list(provider).filter((entry) => entry.type === "chat"),
    getModelsOfType: (type: string, provider?: string) => list(provider).filter((entry) => entry.type === type),
    getModelOfType: (type: string, provider: string, id: string) =>
      list(provider).find((entry) => entry.type === type && entry.id === id),
    getAvailableOfType: async (type: string, provider?: string) =>
      list(provider).filter((entry) => entry.type === type),
    getAllModels: list,
    getAllAvailable: async (provider?: string) => list(provider),
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ configured: true }),
    getAuth: async () => {
      calls++;
      return {};
    },
    login: async () => {
      calls++;
    },
    classify: async () => {
      calls++;
      throw new Error("Must not execute classifier");
    },
    generateImages: async () => {
      calls++;
      throw new Error("Must not execute image generation");
    },
  } as unknown as ModelRuntime;
  if (retainedChatPolicy) {
    Object.defineProperty(target, Symbol.for("pi.model-control.policy"), {
      value: { profile: () => current, patterns: [] },
    });
  }
  installModelPolicy(target, () => current);
  return {
    target,
    calls: () => calls,
    switchProfile: (next: ProfileName) => {
      current = next;
    },
  };
}

test("each profile authorizes only its own pinned classifier", () => {
  expect(NON_CHAT_ALLOWLISTS).toEqual({
    work: { classifier: ["fireworks/accounts/fireworks/models/rune"], image: [] },
    personal: { classifier: ["openrouter/typesafe/jev-1.14"], image: [] },
  });
  const rune = { provider: "fireworks", id: "accounts/fireworks/models/rune", type: "classifier" };
  const jev = { provider: "openrouter", id: "typesafe/jev-1.14", type: "classifier" };
  expect(modelAllowed(rune, "work")).toBe(true);
  expect(modelAllowed(jev, "work")).toBe(false);
  expect(modelAllowed(jev, "personal")).toBe(true);
  expect(modelAllowed(rune, "personal")).toBe(false);
  for (const id of ["~typesafe/jev-latest", "typesafe/jev-router", "typesafe/jev-1.13"]) {
    expect(modelAllowed({ ...jev, id }, "personal")).toBe(false);
  }
  expect(modelAllowed({ ...rune, id: "accounts/fireworks/routers/rune" }, "work")).toBe(false);
  expect(modelAllowed({ ...jev, type: "image" }, "personal")).toBe(false);
});

test("both profiles deny unlisted typed models while retaining their chat catalog", async () => {
  for (const profile of ["work", "personal"] as const) {
    const { target } = fixture(profile);
    for (const entry of [classifier, image]) {
      expect(target.getModelsOfType(entry.type as "classifier" | "image")).toEqual([]);
      expect(await target.getAvailableOfType(entry.type as "classifier" | "image")).toEqual([]);
      expect(target.getModelOfType(entry.type as "classifier" | "image", entry.provider, entry.id)).toBeUndefined();
    }
    const expected = profile === "work" ? [chat] : [chat, personalChat];
    expect(target.getModelsOfType("chat")).toEqual(expected);
    expect(target.getAllModels()).toEqual(expected);
    expect(await target.getAllAvailable()).toEqual(expected);
  }
});

test("both profiles deny execution and auth despite overrides or forged chat discriminants", async () => {
  for (const profile of ["work", "personal"] as const) {
    const { target, calls } = fixture(profile);
    for (const entry of [classifier, image]) {
      await expect(target.getAuth(entry as AnyModel, { apiKey: "bypass" })).rejects.toThrow();
    }
    for (const entry of [classifier, { ...classifier, type: "chat" }, chat]) {
      const result = await target.classify(entry as never, { state: {}, questions: {} }, { apiKey: "bypass" });
      expect(result.stopReason).toBe("error");
      expect(result.answers).toEqual({});
    }
    for (const entry of [image, { ...image, type: "chat" }, chat]) {
      const result = await target.generateImages(entry as never, { input: [] }, { apiKey: "bypass" });
      expect(result.stopReason).toBe("error");
      expect(result.output).toEqual([]);
    }
    const signal = AbortSignal.abort();
    expect((await target.classify(classifier as never, { state: {}, questions: {} }, { signal })).stopReason).toBe(
      "aborted",
    );
    expect((await target.generateImages(image as never, { input: [] }, { signal })).stopReason).toBe("aborted");
    expect(calls()).toBe(0);
  }
});

test("older chat-only policy gains typed guards and reload follows the current profile", async () => {
  const { target, switchProfile, calls } = fixture("personal", true);
  expect(target.getModelsOfType("classifier")).toEqual([]);
  expect(await target.getAvailableOfType("image")).toEqual([]);
  // Use an otherwise allowed provider so auth denial exercises the typed guard.
  await expect(target.getAuth({ ...image, provider: chat.provider } as AnyModel)).rejects.toThrow("model policy");
  const classify = target.classify;
  switchProfile("work");
  expect(target.getModelsOfType("chat")).toEqual([chat]);
  installModelPolicy(target, () => "personal");
  expect(target.classify).toBe(classify);
  expect(target.getModelsOfType("chat")).toEqual([chat, personalChat]);
  expect((await target.classify(classifier as never, { state: {}, questions: {} })).stopReason).toBe("error");
  expect((await target.generateImages(image as never, { input: [] })).stopReason).toBe("error");
  expect(calls()).toBe(0);
});
