import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Type } from "typebox";

interface SourceFixture {
  url: string;
  title: string;
  snippet?: string;
  error?: string;
  query?: string;
}
interface FetchFixture extends SourceFixture {
  content: string;
  thumbnail?: { data: string; mimeType: string };
  frames?: Array<{ data: string; mimeType: string; timestamp: string }>;
}
interface QueryFixture {
  query: string;
  answer?: string;
  providerErrors?: Array<{ provider: string; error: string }>;
  error?: string;
  results: SourceFixture[];
}
interface StoredFixture {
  type: string;
  queries?: QueryFixture[];
  urls?: FetchFixture[];
  artifact?: {
    id?: string;
    sources?: SourceFixture[];
    errors?: Array<{ error: string }>;
    passages?: Array<{ source_url: string; text: string }>;
  };
}
interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface InputResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}
interface OutputResult extends InputResult {
  isError: boolean;
  structuredContent: {
    resultId: string;
    responseId: string | null;
    status: string;
    mode: string;
    content: ContentBlock[];
    sources: SourceFixture[];
    sourceCount: number;
    sourcesTruncated: boolean;
    artifacts: Array<{ responseId?: string; type: string; path?: string }>;
    pagination: { offset?: number; nextOffset?: number; truncated: boolean };
    errors: string[];
  };
}
type ExecuteFixture = (...args: unknown[]) => Promise<InputResult>;
interface RegisteredFixture {
  outputSchema: { properties: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<OutputResult>;
}

const root = process.env.WEB_ACCESS_PACKAGE_ROOT ?? `${import.meta.dir}/../../npm/node_modules/pi-web-access`;
const runtimeTest = existsSync(`${root}/package.json`) ? test : test.skip;
function harness(artifactFailure = false) {
  const bundle = readFileSync(`${root}/dist/index.js`, "utf8");
  const helper = bundle.slice(
    bundle.indexOf("// structured-web-result.ts"),
    bundle.indexOf("function index_default(pi)"),
  );
  let saved = "";
  const helperContext = {
    Type,
    Buffer,
    tmpdir: () => "/tmp",
    join: (...parts: string[]) => parts.join("/"),
    mkdtemp: async () => "/tmp/offline-web-artifact",
    writeFile: async (_path: string, text: string) => {
      if (artifactFailure) throw new Error("offline artifact write failure");
      saved = text;
    },
  };
  const sourceText = new Bun.Transpiler({ loader: "ts" })
    .transformSync(readFileSync(`${root}/structured-web-result.ts`, "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace(/^export /gm, "");
  const source = runInNewContext(`${sourceText}\n({structuredWebResult, webOutputSchema})`, helperContext);
  const loaded = runInNewContext(`${helper}\n({structuredWebResult, webOutputSchema})`, helperContext);
  const wrapperStart = bundle.indexOf("var registerStructuredTool =");
  const wrapper = bundle.slice(wrapperStart, bundle.indexOf("const webSearchEnabled", wrapperStart));
  const check = createRequire(`${root}/package.json`)("typebox/value").Check;
  const tools: RegisteredFixture[] = [];
  const stored = new Map<string, StoredFixture>();
  const register = runInNewContext(`${wrapper}\nregisterStructuredTool`, {
    ...loaded,
    pi: { registerTool: (tool: RegisteredFixture) => tools.push(tool) },
    toolNames: { webSearch: "web_search", sourceCheck: "source_check", fetchContent: "fetch_content" },
    fetchModeConfig: { defaultMode: "readable" },
    getResult: (id: string) => stored.get(id),
    getMaxInlineContentChars: () => 1000,
    initConfig: {},
    isAbortError: (error: Error) => error.name === "AbortError",
  });
  const executeActual = async (name: string, execute: ExecuteFixture, params = {}, signal?: AbortSignal) => {
    register({ name, execute });
    const tool = tools.at(-1);
    const value = await tool.execute("call-actual", params, signal, undefined, {});
    assert.equal(check(tool.outputSchema, value.structuredContent), true, JSON.stringify(value.structuredContent));
    return value;
  };
  const execute = async (name: string, result: InputResult | Error, params = {}, signal?: AbortSignal) => {
    register({
      name,
      execute: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    });
    const tool = tools.at(-1);
    assert.equal(tool.outputSchema, loaded.webOutputSchema);
    const value = await tool.execute("call-1", params, signal);
    assert.deepEqual(Object.keys(value.structuredContent).sort(), Object.keys(tool.outputSchema.properties).sort());
    assert.equal(value.structuredContent.content, value.content);
    assert.equal(check(tool.outputSchema, value.structuredContent), true, JSON.stringify(value.structuredContent));
    const sourceValue = await source.structuredWebResult(
      name,
      "call-1",
      { ...params, ...(name === "fetch_content" ? { mode: (params as { mode?: string }).mode ?? "readable" } : {}) },
      result instanceof Error
        ? {
            content: [{ type: "text", text: "Web operation failed." }],
            details: { error: "Web operation failed" },
            isError: true,
          }
        : result,
      (id: string) => stored.get(id),
      1000,
    );
    assert.equal(JSON.stringify(sourceValue.structuredContent), JSON.stringify(value.structuredContent));
    return value;
  };
  return { execute, executeActual, stored, saved: () => saved, bundle };
}

runtimeTest(
  "pi-web-access loaded registrations expose stable source-linked search and research envelopes",
  async () => {
    const h = harness();
    h.stored.set("search-1", {
      type: "search",
      queries: [
        { query: "docs", results: [{ url: "https://example.com", title: "Docs", snippet: "Evidence" }], error: null },
      ],
    });
    const search = await h.execute("web_search", {
      content: [{ type: "text", text: "Readable search" }],
      details: { searchId: "search-1", fetchId: "fetch-1", successfulQueries: 1 },
    });
    assert.equal(search.structuredContent.responseId, "search-1");
    assert.equal(search.structuredContent.resultId, "web_search:call-1");
    assert.equal(search.structuredContent.sources[0].query, "docs");
    assert.equal(search.structuredContent.artifacts[1].responseId, "fetch-1");
    h.stored.set("research-1", {
      type: "research",
      artifact: {
        sources: [{ url: "https://example.com", title: "Docs" }],
        errors: [{ error: "Unavailable secondary query" }],
      },
    });
    const research = await h.execute("source_check", {
      content: [{ type: "text", text: "Claim evidence" }],
      details: { responseId: "research-1" },
    });
    assert.equal(research.structuredContent.status, "partial");
    assert.equal(research.isError, false);
    assert.equal(research.structuredContent.artifacts[0].type, "research");
    for (const enabled of ["webSearchEnabled", "sourceCheckEnabled", "fetchContentEnabled"])
      assert.ok(h.bundle.includes(`if (${enabled}) registerStructuredTool({`));
    assert.match(h.bundle, /getSearchContentEnabled\) \{[\s\S]*?registerStructuredTool\(\{/);
  },
);

runtimeTest(
  "pi-web-access readable/raw/answer and image content survive structured results without auth persistence",
  async () => {
    for (const mode of ["readable", "raw", "answer"]) {
      const h = harness();
      const image = { type: "image", data: "offline-base64", mimeType: "image/png" };
      const value = await h.execute(
        "fetch_content",
        {
          content: [image, { type: "text", text: `${mode} content` }],
          details: { successful: 1, urls: ["https://example.com"], title: "Page", mode },
        },
        { mode, auth: "private" },
      );
      assert.equal(value.structuredContent.mode, mode);
      assert.equal(value.structuredContent.responseId, null);
      assert.equal(value.structuredContent.sources[0].url, "https://example.com");
      assert.equal(value.content[0].data, image.data);
      assert.equal(value.content[1].text, `${mode} content`);
      assert.equal(h.saved(), "");
    }
  },
);

runtimeTest("pi-web-access retrieval pagination and finds retain source identity and metadata", async () => {
  const h = harness();
  h.stored.set("fetch-1", {
    type: "fetch",
    urls: [{ url: "https://example.com", title: "Page", content: "Full content", error: null }],
  });
  const page = await h.execute(
    "get_search_content",
    {
      content: [{ type: "text", text: "content page" }],
      details: {
        url: "https://example.com",
        offset: 5,
        limit: 10,
        returnedChars: 10,
        nextOffset: 15,
        contentLength: 30,
        truncated: true,
      },
    },
    { responseId: "fetch-1", urlIndex: 0 },
  );
  assert.equal(page.structuredContent.responseId, "fetch-1");
  assert.equal(page.structuredContent.pagination.nextOffset, 15);
  assert.equal(page.structuredContent.pagination.truncated, true);
  const find = await h.execute(
    "get_search_content",
    {
      content: [{ type: "text", text: "matching passage" }],
      details: { url: "https://example.com", contentLength: 30 },
    },
    { responseId: "fetch-1", findText: "passage" },
  );
  assert.equal(find.structuredContent.content[0].text, "matching passage");
  assert.equal(find.structuredContent.sources[0].url, "https://example.com");
});

runtimeTest(
  "pi-web-access errors are structured failures, partial data remains available, aborts stay aborted",
  async () => {
    const h = harness();
    for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
      const value = await h.execute(name, {
        content: [{ type: "text", text: "Invalid request" }],
        details: { error: "Invalid request" },
      });
      assert.equal(value.isError, true);
      assert.equal(value.structuredContent.status, "error");
      assert.equal(value.structuredContent.errors[0], "Invalid request");
      const thrown = await h.execute(name, new Error("secret-provider-error"));
      assert.equal(thrown.isError, true);
      assert.ok(!JSON.stringify(thrown).includes("secret-provider-error"));
    }
    // Exercise the loaded normal search callback and publication, not rendered error text.
    const callbackStart = h.bundle.indexOf(
      "const queryResponses = await runSearchQueries(queryList, async (query) => {",
    );
    const callbackEnd = h.bundle.indexOf("for (const response of queryResponses)", callbackStart);
    const publishStart = h.bundle.indexOf("function storeAndPublishSearch(results)");
    const publishEnd = h.bundle.indexOf("function normalizeSummaryMeta", publishStart);
    const providerErrors = [{ provider: "brave", error: "Unavailable Bearer private-token" }];
    const storedId = await runInNewContext(
      `(async () => {
      ${h.bundle.slice(publishStart, publishEnd)}
      let completedSearches = 0;
      ${h.bundle.slice(callbackStart, callbackEnd)}
      return storeAndPublishSearch(searchResults);
    })()`,
      {
        Error,
        queryList: ["answer-only", "failed"],
        signal: undefined,
        onUpdate: undefined,
        params: {},
        ctx: {},
        recencyFilter: undefined,
        resolvedProvider: "all",
        runSearchQueries: (queries: string[], execute: (query: string) => unknown) => Promise.all(queries.map(execute)),
        search: async (query: string) => {
          if (query === "failed") throw new Error("Query failed");
          return {
            answer: "Useful answer without citations",
            results: [],
            provider: "all",
            providerResponses: [{ provider: "gemini" }],
            providerErrors,
          };
        },
        isAbortError7: () => false,
        toCuratorProvider: (provider: string) => provider,
        generateId: () => "mixed",
        storeResult: (id: string, data: StoredFixture) => h.stored.set(id, data),
        pi: {
          appendEntry: (_type: string, data: StoredFixture) =>
            assert.deepEqual(data.queries?.[0].providerErrors, providerErrors),
        },
      },
    );
    const mixed = await h.execute("web_search", {
      content: [{ type: "text", text: "Useful answer" }],
      details: { searchId: storedId, successfulQueries: 1 },
    });
    assert.equal(mixed.isError, false);
    assert.equal(mixed.structuredContent.status, "partial");
    assert.equal(mixed.structuredContent.sources.length, 0);
    assert.deepEqual(Array.from(mixed.structuredContent.errors), [
      "brave: Unavailable Bearer [REDACTED]",
      "Query failed",
    ]);
    // Provider-level failure alone also remains partial, including later retrieval.
    h.stored.get(storedId).queries.pop();
    const providerPartial = await h.execute(
      "get_search_content",
      { content: [{ type: "text", text: "Useful answer" }], details: {} },
      { responseId: storedId, queryIndex: 0 },
    );
    assert.equal(providerPartial.isError, false);
    assert.equal(providerPartial.structuredContent.status, "partial");
    assert.equal(providerPartial.structuredContent.errors[0], "brave: Unavailable Bearer [REDACTED]");
    h.stored.set("failed", { type: "search", queries: [{ query: "q", results: [], error: "Provider failed" }] });
    assert.equal(
      (await h.execute("web_search", { content: [], details: { searchId: "failed", successfulQueries: 0 } })).isError,
      true,
    );
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await assert.rejects(h.execute("fetch_content", abort), /aborted/);
  },
);

runtimeTest(
  "pi-web-access bounds text, retains images, redacts credentials and creates offline artifacts",
  async () => {
    const h = harness();
    const text = `https://user:password@example.com/?api_key=secret Bearer token-value\n${"x".repeat(2000)}`;
    const value = await h.execute("fetch_content", {
      content: [
        { type: "text", text },
        { type: "image", data: "image", mimeType: "image/png" },
      ],
      details: { successful: 1, urls: ["https://user:password@example.com/?token=secret"] },
    });
    assert.ok(!JSON.stringify(value.structuredContent).includes("password"));
    assert.ok(!JSON.stringify(value.structuredContent).includes("=secret"));
    assert.ok(!h.saved().includes("token-value"));
    assert.equal(value.structuredContent.pagination.truncated, true);
    assert.equal(value.content[1].data, "image");
    assert.equal(value.structuredContent.artifacts[0].path, "/tmp/offline-web-artifact/output.txt");
    assert.ok(Buffer.byteLength(value.content[0].text) <= 1000);
    const auth = await h.execute(
      "fetch_content",
      { content: [{ type: "text", text }], details: { successful: 1 } },
      { auth: "private" },
    );
    assert.equal(auth.structuredContent.artifacts.length, 0);
  },
);

function actualFetch(h: ReturnType<typeof harness>, fixtures: FetchFixture[]) {
  const start = h.bundle.indexOf("async execute(_toolCallId, params", h.bundle.indexOf("if (fetchContentEnabled)"));
  const end = h.bundle.indexOf("renderCall(", start);
  const normalizeStart = h.bundle.indexOf("function normalizeFetchContentParams(");
  const normalizeEnd = h.bundle.indexOf("// index.ts", normalizeStart);
  const sliceStart = h.bundle.indexOf("function initialContentSlice(");
  const sliceEnd = h.bundle.indexOf("function normalizeGetSearchContentParams(", sliceStart);
  const context = {
    Error,
    Buffer,
    normalizeProxyUrl: (value: string) => value,
    fetchModeConfig: { defaultMode: "readable", allowedModes: ["readable", "raw", "answer"] },
    runWithProxy: (_proxy: string, operation: () => unknown) => operation(),
    withRegisteredFetchOptions: (options: unknown) => options,
    registeredToolNames: {},
    getMaxInlineContentChars: () => 1000,
    fetchAllContent2: async () => fixtures,
    answerFromPage: async ({ sourceUrl }: { sourceUrl: string }) => ({ text: `Answer from ${sourceUrl}` }),
    generateId: () => "fetch-actual",
    pi: {},
    getSearchContentEnabled: true,
    toolNames: { getSearchContent: "get_search_content" },
    stripThumbnails: (items: FetchFixture[]) => items.map(({ thumbnail, frames, ...item }) => item),
    resolveAuthFetchProfile: () => ({ cache: "off" }),
    storeFetchResult: (_pi: unknown, id: string, data: StoredFixture, auth: unknown) => {
      if (auth) return false;
      h.stored.set(id, data);
      return true;
    },
  };
  const execute = runInNewContext(
    `${h.bundle.slice(normalizeStart, normalizeEnd)}\n${h.bundle.slice(sliceStart, sliceEnd)}\n({${h.bundle.slice(start, end)}}).execute`,
    context,
  );
  return (params: Record<string, unknown>) => h.executeActual("fetch_content", execute, params);
}

runtimeTest("pi-web-access actual loaded fetch covers modes, cache-off, validation and multi-URL images", async () => {
  const urls = ["https://example.com/one", "https://example.com/two"];
  const fixtures = urls.map((url) => ({ url, title: url, content: "Offline page", error: null }));
  for (const mode of ["readable", "raw", "answer"]) {
    const h = harness();
    const fetch = actualFetch(h, fixtures.slice(0, 1));
    const value = await fetch({ url: urls[0], mode, ...(mode === "answer" ? { prompt: "Question?" } : {}) });
    assert.equal(value.structuredContent.status, "ok");
    assert.equal(value.structuredContent.mode, mode);
    assert.equal(value.structuredContent.responseId, "fetch-actual");
    assert.match(value.content[0].text, mode === "answer" ? /Answer from/ : /Offline page/);
    assert.equal(h.stored.get("fetch-actual").urls[0].content, "Offline page");
  }
  const h = harness();
  const images = fixtures.map((item, index) => ({
    ...item,
    thumbnail: { data: `image-${index}`, mimeType: "image/png" },
  }));
  const fetchImages = actualFetch(h, images);
  const imageValue = await fetchImages({ urls });
  assert.equal(imageValue.content.filter((item: ContentBlock) => item.type === "image").length, 2);
  assert.equal(imageValue.structuredContent.content.filter((item: ContentBlock) => item.type === "image").length, 2);
  const answerImage = await fetchImages({ url: urls[0], mode: "answer", prompt: "Question?" });
  assert.equal(answerImage.isError, true);
  assert.match(answerImage.structuredContent.errors.join(" "), /textual fetched content/);
  for (const params of [
    { url: urls[0], mode: "answer" },
    { url: urls[0], mode: "raw", prompt: "Invalid" },
    { url: urls[0], mode: "invalid" },
    {},
  ]) {
    assert.equal((await actualFetch(h, fixtures)(params)).isError, true);
  }
  const authHarness = harness();
  const partial = await actualFetch(authHarness, [fixtures[0], { ...fixtures[1], error: "Unavailable", content: "" }])({
    urls,
    auth: "private",
  });
  assert.equal(partial.structuredContent.status, "partial");
  assert.equal(partial.structuredContent.responseId, null);
  assert.equal(partial.structuredContent.sources[1].error, "Unavailable");
  assert.equal(authHarness.stored.size, 0);
});

runtimeTest(
  "pi-web-access actual loaded retrieval pages research/search/fetch and reports invalid selectors",
  async () => {
    const h = harness();
    const start = h.bundle.indexOf("async execute(_toolCallId, rawParams)");
    const end = h.bundle.indexOf("renderCall(", start);
    const execute = runInNewContext(`({${h.bundle.slice(start, end)}}).execute`, {
      Error,
      maxInlineContentChars: 1000,
      normalizeGetSearchContentParams: (params: unknown) => params,
      getResult: (id: string) => h.stored.get(id),
      getResearchArtifact: (id: string) => h.stored.get(id)?.artifact,
      formatInputValue: JSON.stringify,
      storedContentSources: "web tools",
      toolNames: { getSearchContent: "get_search_content" },
      formatFullResults: (query: QueryFixture) => `${query.answer}\n${JSON.stringify(query.results)}`,
      normalizeFindQueries: (value: string) => [value],
      findContent: (content: string, [query]: string[]) => ({
        text: content.includes(query) ? query : "No matches",
        matches: [],
      }),
    });
    const get = (params: Record<string, unknown>) => h.executeActual("get_search_content", execute, params);
    h.stored.set("research", {
      type: "research",
      artifact: {
        id: "research",
        sources: [{ url: "https://example.com", title: "Source" }],
        passages: [{ source_url: "https://example.com", text: "Evidence" }],
      },
    });
    h.stored.set("search", {
      type: "search",
      queries: [
        {
          query: "query",
          answer: "Answer",
          error: null,
          results: [{ url: "https://example.com", title: "Source", snippet: "Evidence" }],
        },
      ],
    });
    h.stored.set("fetch", {
      type: "fetch",
      urls: [{ url: "https://example.com", title: "Page", content: "Offline content", error: null }],
    });
    for (const responseId of ["research", "search", "fetch"]) {
      const selectors = responseId === "search" ? { queryIndex: 0 } : responseId === "fetch" ? { urlIndex: 0 } : {};
      const params = { responseId, ...selectors, offset: 0, limit: 5 };
      const page = await get(params);
      assert.equal(page.isError, false);
      assert.equal(page.structuredContent.responseId, responseId);
      assert.equal(page.structuredContent.pagination.nextOffset, 5);
      assert.equal(page.structuredContent.sources[0].url, "https://example.com");
      const next = await get({ ...params, offset: page.structuredContent.pagination.nextOffset });
      assert.equal(next.structuredContent.pagination.offset, 5);
      const found = await get({ ...params, findText: responseId === "fetch" ? "Offline" : "Evidence" });
      assert.match(found.content[0].text, /Offline|Evidence/);
      assert.equal((await get({ ...params, offset: -1 })).isError, true);
    }
    assert.equal((await get({ responseId: "missing" })).isError, true);
    assert.equal((await get({ responseId: "fetch", urlIndex: 9 })).isError, true);
  },
);

runtimeTest(
  "pi-web-access bounded Unicode output, source overflow and post-operation cancellation remain explicit",
  async () => {
    const h = harness();
    h.stored.set("many", {
      type: "search",
      queries: [
        {
          query: "query",
          results: Array.from({ length: 101 }, (_, index) => ({
            url: `https://example.com/${index}`,
            title: "Source",
            snippet: "Evidence",
          })),
        },
      ],
    });
    const value = await h.execute("web_search", {
      content: [{ type: "text", text: "🙂\n".repeat(3000) }],
      details: { searchId: "many", successfulQueries: 1 },
    });
    assert.equal(value.structuredContent.sourceCount, 101);
    assert.equal(value.structuredContent.sources.length, 100);
    assert.equal(value.structuredContent.sourcesTruncated, true);
    assert.ok(
      value.content.every(
        (item: { type: string; text?: string }) => item.type !== "text" || !item.text?.includes("\uFFFD"),
      ),
    );
    assert.ok(
      value.content.reduce(
        (bytes: number, item: { type: string; text?: string }) =>
          bytes + (item.type === "text" ? Buffer.byteLength(item.text ?? "") : 0),
        0,
      ) <= 1000,
    );
    h.stored.set("failed-research", {
      type: "research",
      artifact: { sources: [], errors: [{ error: "Provider unavailable" }] },
    });
    assert.equal(
      (await h.execute("source_check", { content: [], details: { responseId: "failed-research" } })).isError,
      true,
    );
    const controller = new AbortController();
    await assert.rejects(
      h.executeActual(
        "source_check",
        async () => {
          controller.abort(new Error("offline cancellation"));
          return { content: [], details: {} };
        },
        {},
        controller.signal,
      ),
      /offline cancellation/,
    );
  },
);

runtimeTest("pi-web-access artifact IO failures still return schema-matching error data", async () => {
  const h = harness(true);
  const value = await h.execute("fetch_content", {
    content: [{ type: "text", text: "x".repeat(2000) }],
    details: { successful: 1 },
  });
  assert.equal(value.isError, true);
  assert.equal(value.structuredContent.status, "error");
  assert.equal(value.structuredContent.errors[0], "Full-output artifact could not be saved");
  assert.equal(value.structuredContent.artifacts.length, 0);
});
