import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import vertexGeminiSearch from "../../extensions/vertex-gemini-search/index.js";

test("searches go to the pinned Vertex project with ADC tokens, falling back from hung Flex", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vertex-gemini-search-"));
  const adc = join(root, "adc.json");
  await writeFile(
    adc,
    JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh" }),
  );
  const previous = { adc: process.env.GOOGLE_APPLICATION_CREDENTIALS, project: process.env.VERTEX_PROJECT_ID };
  const realFetch = globalThis.fetch;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  // Ambient overrides from the upstream package must not redirect traffic.
  process.env.VERTEX_PROJECT_ID = "someone-elses-project";
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh");
      return Response.json({ access_token: "token-1", expires_in: 3600 });
    }
    if (url.startsWith("https://vertexaisearch.cloud.google.com/")) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/release" } });
    }
    const headers = init?.headers as Record<string, string>;
    // Flex queues on this project until the request times out.
    if (headers["X-Vertex-AI-LLM-Shared-Request-Type"] === "flex") throw new DOMException("timed out", "TimeoutError");
    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: "thinking", thought: true }, { text: "Version 2 shipped." }] },
          groundingMetadata: {
            webSearchQueries: ["version 2 release"],
            groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/redirect/abc" } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
    });
  }) as typeof fetch;

  try {
    const tools = new Map<string, ToolDefinition>();
    let setPricing: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    vertexGeminiSearch({
      registerCommand: (_name: string, command: { handler: typeof setPricing }) => {
        setPricing = command.handler;
      },
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI);
    assert.deepEqual([...tools.keys()], ["web_search", "web_research"]);

    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === "google-vertex" && id === "gemini-3.8-flash" ? { cost: { input: 1, output: 10 } } : undefined,
      },
    };
    const search = (name: string) =>
      tools.get(name)?.execute("call", { query: "latest version?" }, undefined, undefined, ctx as never);

    const result = await search("web_search");
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    assert.ok(!result.isError, text);
    assert.match(text, /Version 2 shipped\./);
    assert.doesNotMatch(text, /thinking/);
    assert.match(text, /1\. example\.com — https:\/\/example\.com\/release/);
    assert.match(text, /gemini-3\.8-flash, global, \$0\.0160, 1 source, standard pricing/);

    const endpoint =
      "https://aiplatform.googleapis.com/v1/projects/optimum-nebula-375615/locations/global/publishers/google/models/gemini-3.8-flash:generateContent";
    const isFlex = (call: (typeof calls)[number]) =>
      (call.init?.headers as Record<string, string> | undefined)?.["X-Vertex-AI-LLM-Shared-Request-Type"] === "flex";
    const vertexCalls = calls.filter((call) => call.url === endpoint);
    assert.deepEqual(vertexCalls.map(isFlex), [false], "standard pricing is the default");
    assert.equal((vertexCalls[0].init?.headers as Record<string, string>).Authorization, "Bearer token-1");

    // Opting into Flex falls back to standard at once when Flex hangs, reusing the cached token.
    await setPricing?.("flex", { ui: { notify: () => {} } });
    calls.length = 0;
    const research = await search("web_research");
    assert.ok(!research.isError);
    assert.match(research.content[0].type === "text" ? research.content[0].text : "", /standard pricing/);
    assert.deepEqual(
      calls.map((call) => [call.url, isFlex(call)]),
      [
        [endpoint, true],
        [endpoint, false],
        ["https://vertexaisearch.cloud.google.com/redirect/abc", false],
      ],
    );
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of [
      ["GOOGLE_APPLICATION_CREDENTIALS", previous.adc],
      ["VERTEX_PROJECT_ID", previous.project],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
