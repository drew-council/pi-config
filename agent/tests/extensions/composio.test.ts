import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type ComposioConnection,
  createComposioConnection,
  decodeComposioResult,
} from "../../extensions/composio/client.js";
import { isComposioToolAllowed, readComposioKey, readComposioPolicy } from "../../extensions/composio/config.js";
import { registerComposio } from "../../extensions/composio/index.js";

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

function harness(connect?: (signal: AbortSignal) => Promise<ComposioConnection>) {
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
    connect: (signal) => {
      connects += 1;
      return connect ? connect(signal) : Promise.resolve(fake.connection);
    },
  });
  return {
    ...fake,
    tools,
    ctx,
    active: () => active,
    connects: () => connects,
    statuses,
    notifications,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    command: (args = "") => commands.get("composio").handler(args, ctx),
    runTool: (name: string, args: unknown, signal?: AbortSignal) =>
      tools.get(name).execute("test-call", args, signal, undefined, ctx as unknown as ExtensionToolContext),
  };
}

test("Composio is off at startup and direct calls cannot activate it", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.connects(), 0);
  assert.deepEqual(h.active(), ["read", "foreign"]);
  assert.ok([...h.tools.values()].every((tool) => tool.defaultActive === false));
  assert.equal(h.statuses.at(-1), undefined);
  assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  assert.deepEqual(h.emit("tool_call", { toolName: "composio_execute_tool" }), {
    block: true,
    reason: "Composio is disabled. Run /composio to enable it for this session.",
  });
  await assert.rejects(h.runTool("composio_execute_tool", { toolSlug: "GMAIL_SEND_EMAIL" }), /disabled/);
  assert.equal(h.connects(), 0);
  assert.deepEqual(h.calls, []);
});

test("the slash command connects once, updates the footer, and detaches without changing other tools", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command();
  await h.command("on");
  assert.equal(h.connects(), 1);
  assert.deepEqual(h.active(), ["read", "foreign", ...h.tools.keys()]);
  assert.equal(h.statuses.at(-1), "Composio connected");
  assert.match(
    (h.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string }).systemPrompt,
    /^base\n/,
  );
  await h.command("off");
  assert.deepEqual(h.active(), ["read", "foreign"]);
  assert.equal(h.closes(), 1);
  assert.equal(h.statuses.at(-1), undefined);
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /disabled/);
});

test("new, resumed, forked, and reloaded sessions all require another slash command", async () => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const h = harness();
    await h.command();
    await h.emit("session_start", { reason });
    assert.equal(h.connects(), 1);
    assert.equal(h.closes(), 1);
    assert.deepEqual(h.active(), ["read", "foreign"]);
    await assert.rejects(h.runTool("composio_search_tools", { query: "inbox" }), /disabled/);
  }
});

test("a connection completed after session replacement is closed and never activated", async () => {
  const fake = fakeConnection();
  let resolve: (connection: ComposioConnection) => void;
  let signal: AbortSignal;
  const h = harness((requestSignal) => {
    signal = requestSignal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const attaching = h.command();
  await new Promise((done) => setImmediate(done));
  await h.emit("session_start", { reason: "new" });
  assert.equal(signal.aborted, true);
  resolve(fake.connection);
  await attaching;
  assert.equal(fake.closes(), 1);
  assert.deepEqual(h.active(), ["read", "foreign"]);
  assert.equal(h.statuses.at(-1), undefined);
});

test("a synchronous credential error leaves Composio off and permits a subsequent retry", async () => {
  const fake = fakeConnection();
  let attempts = 0;
  const h = harness(() => {
    if (++attempts === 1) throw new Error("Missing credential");
    return Promise.resolve(fake.connection);
  });
  await h.command();
  assert.equal(h.statuses.at(-1), undefined);
  assert.deepEqual(h.active(), ["read", "foreign"]);
  assert.equal(h.notifications.at(-1).level, "error");
  await h.command();
  assert.equal(h.connects(), 2);
  assert.equal(h.statuses.at(-1), "Composio connected");
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
