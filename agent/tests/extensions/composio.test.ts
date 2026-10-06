import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiToolDetails } from "@composio/experimental";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type ComposioConnection,
  createComposioConnection,
  createRetryingFetch,
  decodeComposioResult,
} from "../../extensions/composio/client.js";
import { isComposioToolAllowed, readComposioKey, readComposioPolicy } from "../../extensions/composio/config.js";
import { type ComposioConfig, registerComposio } from "../../extensions/composio/index.js";

const POLICY = { toolkits: ["gmail"], tools: {} };

function fakeConnection() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let closes = 0;
  const connection: ComposioConnection = {
    policy: POLICY,
    search: async (...args) => {
      calls.push({ method: "search", args });
      return { successful: true };
    },
    execute: async (...args) => {
      calls.push({ method: "execute", args });
      return { successful: true };
    },
    manageConnections: async (...args) => {
      calls.push({ method: "connections", args });
      return { successful: true };
    },
    close: async () => {
      closes += 1;
    },
  };
  return { connection, calls, closes: () => closes };
}

function harness(
  options: { connect?: (signal: AbortSignal) => Promise<ComposioConnection>; loadConfig?: () => ComposioConfig } = {},
) {
  const fake = fakeConnection();
  let connects = 0;
  let active = ["read", "foreign"];
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text?: string) => statuses.push(text),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, definition: typeof commands extends Map<string, infer V> ? V : never) =>
      commands.set(name, definition),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as ExtensionAPI;
  registerComposio(pi, {
    loadConfig: options.loadConfig ?? (() => ({ apiKey: "ck_test", policy: POLICY })),
    connect: (_config, signal) => {
      connects += 1;
      return options.connect ? options.connect(signal) : Promise.resolve(fake.connection);
    },
  });
  return {
    ...fake,
    tools,
    ctx,
    active: () => active,
    exposures: () => [...tools.values()].map((tool) => tool.exposure),
    connects: () => connects,
    statuses,
    notifications,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    command: (args = "") => commands.get("composio").handler(args, ctx),
    runTool: (name: string, args: unknown, signal?: AbortSignal) =>
      tools.get(name).execute("test-call", args, signal, undefined, ctx as unknown as ExtensionToolContext),
  };
}

test("Composio is off at startup and calls are rejected without connecting", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  assert.deepEqual(h.active(), ["read", "foreign"]);
  assert.deepEqual(h.exposures(), ["hidden", "hidden", "hidden"]);
  assert.equal(h.statuses.at(-1), undefined);
  assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  assert.deepEqual(h.emit("tool_call", { toolName: "composio_execute_tool", parentToolCallId: "parent" }), {
    block: true,
    reason: "Composio is disabled. Run /composio to enable it for this session.",
  });
  await assert.rejects(h.runTool("composio_execute_tool", { toolSlug: "GMAIL_SEND_EMAIL" }), /disabled/);
  assert.equal(h.connects(), 0);
  assert.deepEqual(h.calls, []);
});

test("toggling is local; the first call connects once and later or concurrent calls share the connection", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command();
  assert.equal(h.connects(), 0);
  assert.deepEqual(h.active(), ["read", "foreign", "codemode"]);
  assert.deepEqual(h.exposures(), ["codemode", "codemode", "codemode"]);
  assert.equal(h.statuses.at(-1), "Composio on");
  assert.match(
    (h.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string }).systemPrompt,
    /^base\n[\s\S]*Allowed Composio toolkits: gmail\./,
  );
  await Promise.all([
    h.runTool("composio_search_tools", { query: "inbox" }),
    h.runTool("composio_search_tools", { query: "labels" }),
  ]);
  await h.command("on");
  await h.runTool("composio_manage_connections", { toolkits: ["gmail"] });
  assert.equal(h.connects(), 1);
  assert.match(h.notifications.at(-1).message, /already on/);

  await h.command("off");
  assert.deepEqual(h.exposures(), ["hidden", "hidden", "hidden"]);
  await new Promise((done) => setImmediate(done));
  assert.equal(h.closes(), 1);
  assert.equal(h.statuses.at(-1), undefined);
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /off/);
  await h.command();
  await h.runTool("composio_search_tools", { query: "inbox" });
  assert.equal(h.connects(), 2);
});

test("a failed connection rejects that call and the next call connects again", async () => {
  const fake = fakeConnection();
  let attempts = 0;
  const h = harness({
    connect: () => {
      if (++attempts === 1) throw new Error("Bad gateway");
      return Promise.resolve(fake.connection);
    },
  });
  await h.command();
  await assert.rejects(h.runTool("composio_search_tools", { query: "inbox" }), /Bad gateway/);
  assert.deepEqual(h.exposures(), ["codemode", "codemode", "codemode"]);
  await h.runTool("composio_search_tools", { query: "inbox" });
  assert.equal(attempts, 2);
  assert.equal(fake.calls.length, 1);
});

test("configuration errors are reported when enabling and leave Composio off", async () => {
  let attempts = 0;
  const h = harness({
    loadConfig: () => {
      if (++attempts === 1) throw new Error("Missing composio.apiKey");
      return { apiKey: "ck_test", policy: POLICY };
    },
  });
  await h.command();
  assert.deepEqual(h.notifications.at(-1), { message: "Missing composio.apiKey", level: "error" });
  assert.deepEqual(h.exposures(), ["hidden", "hidden", "hidden"]);
  assert.equal(h.statuses.at(-1), undefined);
  await h.command();
  assert.equal(h.statuses.at(-1), "Composio on");
  assert.equal(h.connects(), 0);
});

test("new, resumed, forked, and reloaded sessions all require another slash command", async () => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const h = harness();
    await h.command();
    await h.runTool("composio_search_tools", { query: "inbox" });
    await h.emit("session_start", { reason });
    await new Promise((done) => setImmediate(done));
    assert.equal(h.closes(), 1);
    assert.deepEqual(h.exposures(), ["hidden", "hidden", "hidden"]);
    await assert.rejects(h.runTool("composio_search_tools", { query: "inbox" }), /disabled/);
  }
});

test("disabling while connecting aborts the attempt and closes a connection that completes later", async () => {
  const fake = fakeConnection();
  let resolve: (connection: ComposioConnection) => void;
  let signal: AbortSignal;
  const h = harness({
    connect: (requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await h.command();
  const call = h.runTool("composio_search_tools", { query: "inbox" });
  await new Promise((done) => setImmediate(done));
  await h.command("off");
  assert.equal(signal.aborted, true);
  resolve(fake.connection);
  await Promise.allSettled([call]);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.closes(), 1);
  assert.deepEqual(h.exposures(), ["hidden", "hidden", "hidden"]);
});

test("connected Composio tools only accept calls issued by another tool such as codemode", async () => {
  const h = harness();
  await h.command();
  for (const toolName of h.tools.keys()) {
    const blocked = h.emit("tool_call", { toolName, toolCallId: "direct" }) as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /only callable from codemode/);
    assert.equal(h.emit("tool_call", { toolName, toolCallId: "parent/1", parentToolCallId: "parent" }), undefined);
  }
  assert.equal(h.emit("tool_call", { toolName: "read" }), undefined);
});

test("native Pi helpers preserve cancellation, account selection, arguments, and connection intent", async () => {
  const h = harness();
  await h.command();
  const signal = new AbortController().signal;
  await h.runTool("composio_search_tools", { query: "inbox", toolkits: ["gmail"] }, signal);
  await h.runTool(
    "composio_execute_tool",
    { toolSlug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 3 }, account: "personal" },
    signal,
  );
  await h.runTool("composio_manage_connections", { toolkits: ["gmail"] }, signal);
  assert.deepEqual(h.calls, [
    { method: "search", args: ["inbox", ["gmail"], signal] },
    { method: "execute", args: ["GMAIL_FETCH_EMAILS", { max_results: 3 }, "personal", signal] },
    { method: "connections", args: [["gmail"], false, signal] },
  ]);
});

test("all Composio tools expose decoded objects while preserving direct-call text and metadata", async () => {
  const h = harness();
  await h.command();
  for (const [name, args] of [
    ["composio_search_tools", { query: "inbox" }],
    ["composio_execute_tool", { toolSlug: "GMAIL_FETCH_EMAILS", arguments: {} }],
    ["composio_manage_connections", { toolkits: ["gmail"] }],
  ] as const) {
    const tool = h.tools.get(name);
    const schema = tool.outputSchema as { type?: string; additionalProperties?: boolean };
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, true);
    assert.equal(tool.namespace.name, "composio");
    assert.match(tool.namespace.instructions, /response object, not a JSON string/);
    assert.ok(tool.promptGuidelines.some((guideline) => guideline.includes("decoded response objects")));
    assert.equal(tool.annotations.readOnlyHint, name === "composio_search_tools");
    assert.equal(tool.annotations.destructiveHint, name !== "composio_search_tools");
    const result = await h.runTool(name, args);
    assert.deepEqual(result.structuredContent, { successful: true });
    const details = result.details as PiToolDetails;
    assert.deepEqual(result.structuredContent, details.result);
    assert.deepEqual(
      JSON.parse(result.content[0].type === "text" ? result.content[0].text : ""),
      result.structuredContent,
    );
    assert.equal(typeof details.slug, "string");
  }
});

test("parallel Composio calls keep their individual cancellation signals and decoded responses", async () => {
  const signals = [new AbortController().signal, new AbortController().signal];
  const connection: ComposioConnection = {
    ...fakeConnection().connection,
    execute: async (_slug, args, _account, signal) => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(signal, signals[args.index as number]);
      return { successful: true, data: { index: args.index, extra: [false, null, { count: 0 }] } };
    },
  };
  const h = harness({ connect: async () => connection });
  await h.command();
  const results = await Promise.all(
    signals.map((signal, index) =>
      h.runTool("composio_execute_tool", { toolSlug: "GMAIL_FETCH_EMAILS", arguments: { index } }, signal),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.structuredContent),
    signals.map((_signal, index) => ({ successful: true, data: { index, extra: [false, null, { count: 0 }] } })),
  );
});

test("cancelling a Composio tool aborts its connection request and rejects rather than returning success", async () => {
  const controller = new AbortController();
  const connection: ComposioConnection = {
    ...fakeConnection().connection,
    execute: async (_slug, _args, _account, signal) => {
      assert.equal(signal, controller.signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const h = harness({ connect: async () => connection });
  await h.command();
  await h.runTool("composio_search_tools", { query: "inbox" });
  const call = h.runTool("composio_execute_tool", { toolSlug: "GMAIL_FETCH_EMAILS" }, controller.signal);
  const rejected = assert.rejects(call, /cancelled/);
  await new Promise((done) => setImmediate(done));
  controller.abort(new Error("cancelled"));
  await rejected;
});

test("cancelling a call that is waiting for the connection ends that call without cancelling the connection", async () => {
  const fake = fakeConnection();
  let resolve: (connection: ComposioConnection) => void;
  let connectSignal: AbortSignal;
  const h = harness({
    connect: (signal) => {
      connectSignal = signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await h.command();
  const controller = new AbortController();
  const cancelled = h.runTool("composio_search_tools", { query: "inbox" }, controller.signal);
  const waiting = h.runTool("composio_search_tools", { query: "labels" });
  await new Promise((done) => setImmediate(done));
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(connectSignal.aborted, false);
  resolve(fake.connection);
  await waiting;
  assert.deepEqual(
    fake.calls.map((call) => call.args[0]),
    ["labels"],
  );
});

test("the consumer adapter decodes JSON separately from appended prose", () => {
  assert.deepEqual(
    decodeComposioResult({
      content: [
        { type: "text", text: '{"successful":true,"data":{"messages":[]}}' },
        { type: "text", text: "Additional service guidance" },
      ],
    }),
    { successful: true, data: { messages: [] } },
  );
});

test("consumer execution preserves the search session and sends one app call without workbench offloading", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  const connection = createComposioConnection(
    POLICY,
    async (name, args, signal) => {
      calls.push({ name, args, signal });
      return {
        content: [
          { type: "text", text: JSON.stringify({ successful: true, data: { session: { id: "workflow-id" } } }) },
        ],
      };
    },
    async () => {},
  );
  const signal = new AbortController().signal;
  await connection.search("inbox", undefined, signal);
  await connection.execute("GMAIL_FETCH_EMAILS", { label_ids: ["INBOX"], max_results: 3 }, "personal", signal);
  assert.deepEqual(calls[0].args.session, { generate_id: true });
  assert.deepEqual(calls[1], {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    args: {
      tools: [
        { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { label_ids: ["INBOX"], max_results: 3 }, account: "personal" },
      ],
      sync_response_to_workbench: false,
      current_step: "EXECUTING_TOOL",
      session_id: "workflow-id",
    },
    signal,
  });
});

test("toolkit/action policy rejects forbidden app tools, schema lookups, and meta-tool bypasses before a network call", async () => {
  const policy = { toolkits: ["gmail"], tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } } };
  let calls = 0;
  const connection = createComposioConnection(
    policy,
    async () => {
      calls += 1;
      return { content: [] };
    },
    async () => {},
  );
  for (const slug of [
    "GMAIL_SEND_EMAIL",
    "GITHUB_CREATE_ISSUE",
    "COMPOSIO_REMOTE_BASH_TOOL",
    "COMPOSIO_MULTI_EXECUTE_TOOL",
  ]) {
    await assert.rejects(connection.execute(slug, {}), /policy does not allow/);
  }
  await assert.rejects(connection.execute("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: ["GMAIL_SEND_EMAIL"] }), /policy/);
  await assert.rejects(connection.search("issues", ["github"]), /policy/);
  await assert.rejects(connection.manageConnections(["github"], true), /policy/);
  assert.equal(calls, 0);
  assert.equal(
    isComposioToolAllowed({ toolkits: ["gmail"], tools: { gmail: { enable: [] } } }, "GMAIL_FETCH_EMAILS"),
    false,
  );
  assert.equal(
    isComposioToolAllowed(
      { toolkits: ["gmail"], tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"], disable: ["GMAIL_FETCH_EMAILS"] } } },
      "GMAIL_FETCH_EMAILS",
    ),
    false,
  );
});

test("gateway rejections are resent with backoff, other statuses are returned as is", async () => {
  const statuses: number[] = [];
  const responses = (codes: number[]) => {
    const queue = [...codes];
    return (async () => {
      const status = queue.shift();
      statuses.push(status);
      return new Response(status === 202 ? null : "x", { status });
    }) as unknown as typeof fetch;
  };
  const call = {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
    }),
  };

  assert.equal((await createRetryingFetch(responses([502, 503, 200]), [0, 0, 0])("u", call)).status, 200);
  assert.deepEqual(statuses.splice(0), [502, 503, 200]);
  assert.equal((await createRetryingFetch(responses([502, 502, 502]), [0, 0])("u", call)).status, 502);
  assert.deepEqual(statuses.splice(0), [502, 502, 502]);
  for (const status of [401, 500, 504]) {
    assert.equal((await createRetryingFetch(responses([status, 200]), [0])("u", call)).status, status);
    assert.deepEqual(statuses.splice(0), [status]);
  }

  const controller = new AbortController();
  const retrying = createRetryingFetch(responses([502, 200]), [60_000])("u", { ...call, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));
  await assert.rejects(retrying, /cancelled/);
  assert.deepEqual(statuses.splice(0), [502]);
});

test("MCP failures become execution errors and connection inspection uses the side-effect-free list action", async () => {
  const connection = createComposioConnection(
    POLICY,
    async (_name, args) => {
      assert.deepEqual(args.toolkits, [{ name: "gmail", action: "list" }]);
      return { isError: true, content: [{ type: "text", text: "Connection expired" }] };
    },
    async () => {},
  );
  await assert.rejects(connection.manageConnections(["gmail"], false), /Connection expired/);
});

async function runCodemode(
  session: AgentSession,
  code: string,
  signal = new AbortController().signal,
): Promise<string> {
  const id = `composio-codemode-${session.sessionManager.getEntries().length}`;
  // Seed the assistant call without making a provider request. Nested tools use Pi's real pipeline.
  session.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "composio-test",
    content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  session.refreshContext();
  const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
  const result = await tool.execute(id, { code }, signal);
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

for (const mode of ["on", "only"] as const) {
  test(`Composio works through the real codemode pipeline (${mode}) without bypassing activation or policy`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-composio-codemode-"));
    let session: AgentSession | undefined;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connection = createComposioConnection(
      { toolkits: ["gmail"], tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } } },
      async (name, args) => {
        calls.push({ name, args });
        if (name === "COMPOSIO_SEARCH_TOOLS") {
          return {
            structuredContent: {
              successful: true,
              data: {
                session: { id: "codemode-session" },
                tool_schemas: { GMAIL_FETCH_EMAILS: {}, GMAIL_SEND_EMAIL: {} },
              },
            },
            content: [{ type: "text", text: "Appended service guidance" }],
          };
        }
        const tool = (
          args.tools as Array<{ tool_slug: string; arguments: Record<string, unknown>; account?: string }>
        )[0];
        if (tool.arguments.q === "fail") return { isError: true, content: [{ type: "text", text: "App unavailable" }] };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                successful: true,
                data: {
                  results: [
                    { tool_slug: tool.tool_slug, response: { query: tool.arguments.q, account: tool.account } },
                  ],
                },
              }),
            },
          ],
        };
      },
      async () => {},
    );
    try {
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          createCodemodeExtension(),
          (pi) =>
            registerComposio(pi, {
              loadConfig: () => ({ apiKey: "ck_test", policy: POLICY }),
              connect: async () => connection,
            }),
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models-store.json"),
        refreshOnCreate: false,
      });
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        modelRuntime,
        sessionManager: SessionManager.inMemory(directory),
      }));
      initTheme("dark", false);
      await session.bindExtensions({});
      assert.ok(!session.getCallableToolNames().some((name) => name.startsWith("composio_")));
      const disabled = await runCodemode(
        session,
        'return ALL_TOOLS.filter(tool => tool.name.startsWith("composio_"));',
      );
      assert.match(disabled, /Script completed/);
      assert.match(disabled, /Output:\s*\[\]/);
      assert.deepEqual(calls, []);
      await session.prompt("/composio");
      assert.ok(session.getCallableToolNames().includes("composio_execute_tool"));
      assert.ok(!session.getActiveToolNames().some((name) => name.startsWith("composio_")));
      assert.ok(session.getActiveToolNames().includes("codemode"));
      const output = await runCodemode(
        session,
        `
        const namespace = await describeNamespace("composio");
        const discovery = await tools.composio_search_tools({query: "Fetch inbox emails"});
        const results = await Promise.allSettled([
          ...["first", "second", "fail"].map(q => tools.composio_execute_tool({toolSlug: "GMAIL_FETCH_EMAILS", arguments: {q}, account: "personal"})),
          tools.composio_execute_tool({toolSlug: "GMAIL_SEND_EMAIL", arguments: {}}),
        ]);
        return {namespace: namespace.name, schemas: Object.keys(discovery.data.tool_schemas), results: results.map(result => result.status === "fulfilled" ? result.value.data.results[0].response : {error: result.reason.message})};
      `,
      );
      assert.match(output, /Script completed/);
      assert.match(output, /"namespace":"composio"/);
      assert.match(output, /"schemas":\["GMAIL_FETCH_EMAILS"\]/);
      assert.match(output, /"query":"first","account":"personal"/);
      assert.match(output, /"query":"second","account":"personal"/);
      assert.match(output, /App unavailable/);
      assert.match(output, /policy does not allow GMAIL_SEND_EMAIL/);
      assert.equal(calls.length, 4);
      for (const call of calls.slice(1)) assert.equal(call.args.session_id, "codemode-session");
      await session.prompt("/composio off");
      assert.ok(!session.getCallableToolNames().some((name) => name.startsWith("composio_")));
      const afterOff = await runCodemode(
        session,
        'return ALL_TOOLS.filter(tool => tool.name.startsWith("composio_"));',
      );
      assert.match(afterOff, /Output:\s*\[\]/);
      assert.equal(calls.length, 4);
    } finally {
      session?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("credential and policy readers reject unresolved secrets, malformed JSON, and misspelled policy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-composio-test-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({ composio: { apiKey: "{{ op://Private/key/credential }}" } }));
    assert.throws(() => readComposioKey(path), /Missing composio.apiKey/);
    await writeFile(path, '{"composio": SECRET_MUST_NOT_LEAK');
    assert.throws(
      () => readComposioKey(path),
      (error: Error) => !error.message.includes("SECRET_MUST_NOT_LEAK"),
    );
    await writeFile(path, JSON.stringify({ toolkits: ["gmail"], tool: { gmail: [] } }));
    assert.throws(() => readComposioPolicy(path), /Unknown.*tool/);
    await writeFile(path, JSON.stringify(POLICY));
    assert.deepEqual(readComposioPolicy(path), POLICY);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
