import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import googleXHighThinkingExtension, { XHIGH_MODELS } from "../../extensions/google-xhigh-thinking.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function createHarness(level: string, model?: { provider: string; id: string }) {
  let handler: Handler | undefined;
  googleXHighThinkingExtension({
    on: (event: string, fn: Handler) => {
      if (event === "before_provider_request") handler = fn;
    },
    getThinkingLevel: () => level,
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  const ctx = { model } as unknown as ExtensionContext;
  return (payload: unknown) => handler!({ type: "before_provider_request", payload }, ctx);
}

const neon = { provider: "google-vertex", id: "gemini-4-neon" };
const abortSignal = new AbortController().signal;
const highPayload = () => ({
  model: "gemini-4-neon",
  contents: [],
  config: { abortSignal, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } },
});

test("rewrites HIGH to XHIGH at xhigh on a listed model", () => {
  const payload = highPayload();
  const result = createHarness("xhigh", neon)(payload) as ReturnType<typeof highPayload>;
  assert.equal(result.config.thinkingConfig.thinkingLevel, "XHIGH");
  assert.equal(result.config.thinkingConfig.includeThoughts, true);
  assert.equal(result.config.abortSignal, abortSignal);
  assert.equal(payload.config.thinkingConfig.thinkingLevel, "HIGH");
});

test("leaves the payload alone below xhigh", () => {
  assert.equal(createHarness("high", neon)(highPayload()), undefined);
});

test("leaves unlisted models alone", () => {
  assert.equal(createHarness("xhigh", { provider: "google-vertex", id: "gemini-4-carbon" })(highPayload()), undefined);
  assert.equal(createHarness("xhigh")(highPayload()), undefined);
});

test("leaves payloads without a HIGH thinking level alone", () => {
  const run = createHarness("xhigh", neon);
  assert.equal(run({ config: { thinkingConfig: { thinkingLevel: "LOW" } } }), undefined);
  assert.equal(run({ config: {} }), undefined);
  assert.equal(run(undefined), undefined);
});

test("listed models map xhigh to high in models.json", () => {
  const models = JSON.parse(readFileSync(join(import.meta.dir, "../../models.json"), "utf8")) as {
    providers: Record<string, { models: Array<{ id: string; thinkingLevelMap?: Record<string, string | null> }> }>;
  };
  for (const key of XHIGH_MODELS) {
    const [provider, id] = key.split("/");
    const model = models.providers[provider]?.models.find((m) => m.id === id);
    assert.equal(model?.thinkingLevelMap?.xhigh, "high", key);
  }
});
