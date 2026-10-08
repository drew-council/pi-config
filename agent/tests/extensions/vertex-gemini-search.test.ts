import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type ExtensionAPI, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import vertexGeminiSearch from "../../extensions/vertex-gemini-search/index.js";

const PINNED = {
  GOOGLE_CLOUD_PROJECT: "optimum-nebula-375615",
  GOOGLE_CLOUD_LOCATION: "global",
  GOOGLE_APPLICATION_CREDENTIALS: "/adc.json",
};
const REDIRECT = "https://vertexaisearch.cloud.google.com/redirect/abc";

function message(stopReason: AssistantMessage["stopReason"], text = ""): AssistantMessage {
  return {
    role: "assistant",
    api: "google-vertex",
    provider: "google-vertex",
    model: "gemini-3.8-flash",
    content: text ? [{ type: "text", text }] : [],
    usage: {
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1100,
      cost: { input: 0.00075, output: 0.000375, cacheRead: 0, cacheWrite: 0, total: 0.001125 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

interface Call {
  context: Context;
  options: SimpleStreamOptions;
  payload: { config: { tools?: unknown[]; labels?: Record<string, string> } };
}

/** A registry whose Vertex provider hangs on Flex and answers with grounding on standard. */
function fakeRegistry(env: Record<string, string>) {
  const calls: Call[] = [];
  const registry = {
    find: (provider: string, id: string) => (provider === "google-vertex" ? { provider, id } : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, env }),
    streamSimple(_model: unknown, context: Context, options: SimpleStreamOptions) {
      const flex = (options.headers as Record<string, string> | undefined)?.["X-Vertex-AI-LLM-Shared-Request-Type"];
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
          const payload = (await options.onPayload?.({ model: "gemini-3.8-flash", config: { maxOutputTokens: 1 } }, {
            id: "gemini-3.8-flash",
          } as never)) as Call["payload"];
          calls.push({ context, options, payload });
          if (flex) return;
          await options.onProviderStreamEvent?.({ candidates: [{ content: {} }] }, {} as never);
          for (const delta of ["Version 2 ", "shipped."]) {
            yield { type: "text_delta", contentIndex: 0, delta, partial: message("pending") };
          }
          await options.onProviderStreamEvent?.(
            {
              candidates: [
                {
                  groundingMetadata: {
                    webSearchQueries: ["version 2 release"],
                    groundingChunks: [{ web: { uri: REDIRECT } }, { web: { uri: REDIRECT } }],
                  },
                },
              ],
            },
            {} as never,
          );
        },
        result: async () => (flex ? message("aborted") : message("stop", "Version 2 shipped.")),
      };
    },
  };
  return { registry, calls };
}

function load() {
  const tools = new Map<string, ToolDefinition>();
  let pricing: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  vertexGeminiSearch({
    registerCommand: (_name: string, command: { handler: typeof pricing }) => {
      pricing = command.handler;
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  return { tools, pricing: (args: string) => pricing?.(args, { ui: { notify: () => {} } }) };
}

test("searches run through the pinned google-vertex provider with grounding, usage, and structured output", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), REDIRECT);
    return new Response(null, { status: 302, headers: { location: "https://example.com/release" } });
  }) as typeof fetch;
  try {
    const { tools, pricing } = load();
    assert.deepEqual([...tools.keys()], ["web_search", "web_research"]);
    for (const tool of tools.values()) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.openWorldHint, true);
      assert.ok(tool.outputSchema);
    }

    const { registry, calls } = fakeRegistry(PINNED);
    const updates: string[] = [];
    const search = (name: string) =>
      tools
        .get(name)
        ?.execute(
          "call",
          { query: "latest version?" },
          undefined,
          (partial) => updates.push(partial.content[0]?.type === "text" ? partial.content[0].text : ""),
          { modelRegistry: registry } as never,
        );

    const result = await search("web_search");
    assert.equal(
      result.content[0]?.type === "text" && result.content[0].text,
      ["Version 2 shipped.", "", "Sources:", "1. example.com — https://example.com/release"].join("\n"),
    );
    assert.deepEqual(result.structuredContent, result.details);
    assert.deepEqual(result.details, {
      answer: "Version 2 shipped.",
      sources: [{ host: "example.com", url: "https://example.com/release" }],
      searchQueries: ["version 2 release"],
      model: "gemini-3.8-flash",
      location: "global",
      serviceTier: "standard",
      costUsd: 0.015125,
    });
    // Token cost plus one grounded query, so the session total includes the search.
    assert.equal(result.usage?.cost.total, 0.015125);
    assert.deepEqual(updates, ["Version 2 ", "Version 2 shipped."]);

    assert.equal(calls.length, 1, "standard pricing is the default");
    assert.equal(calls[0].options.headers, undefined);
    assert.equal(calls[0].options.maxTokens, 2000);
    assert.match(calls[0].context.systemPrompt ?? "", /QUICK verification/);
    assert.deepEqual(calls[0].payload.config.tools, [{ googleSearch: {} }, { urlContext: {} }]);
    assert.equal(calls[0].payload.config.labels?.tier, "standard");

    // Opting into Flex falls back to standard when Flex fails, then stays on standard.
    await pricing("flex");
    calls.length = 0;
    const research = await search("web_research");
    assert.equal((research.details as { serviceTier: string }).serviceTier, "standard");
    await search("web_research");
    assert.deepEqual(
      calls.map((call) => call.payload.config.labels?.tier),
      ["flex", "standard", "standard"],
    );
    assert.equal(calls[1].options.maxTokens, 12000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("searches refuse credentials not pinned to Sheer Health's Vertex project", async () => {
  const { tools } = load();
  const run = (env: Record<string, string>) =>
    tools
      .get("web_search")
      ?.execute("call", { query: "q" }, undefined, undefined, { modelRegistry: fakeRegistry(env).registry } as never);
  await assert.rejects(run({ ...PINNED, GOOGLE_CLOUD_PROJECT: "someone-elses-project" }), /\/log-me-in/);
  await assert.rejects(run({}), /\/log-me-in/);
  const { GOOGLE_APPLICATION_CREDENTIALS: _, ...withoutAdc } = PINNED;
  await assert.rejects(run(withoutAdc), /gcloud auth application-default login/);
});

test("collapsed results preview the answer; expanded results add the sources", () => {
  initTheme("dark", false);
  const { tools } = load();
  const render = tools.get("web_search")?.renderResult;
  assert.ok(render);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const result = {
    content: [{ type: "text" as const, text: "unused" }],
    details: {
      answer: ["one", "two", "three", "four", "five"].join("\n"),
      sources: [{ host: "example.com", url: "https://example.com/a" }],
      searchQueries: [],
      model: "gemini-3.8-flash",
      location: "global",
      serviceTier: "standard",
      costUsd: 0.015,
    },
  };
  const draw = (expanded: boolean) =>
    render(result, { expanded, isPartial: false }, theme as never, { isError: false } as never)
      .render(200)
      .join("\n");
  const collapsed = draw(false);
  assert.match(collapsed, /gemini-3\.8-flash · global · \$0\.0150 · 1 source · standard pricing/);
  assert.match(collapsed, /four/);
  assert.doesNotMatch(collapsed, /five|example\.com/);
  const expanded = draw(true);
  assert.match(expanded, /five/);
  assert.match(expanded, /example\.com/);
});
