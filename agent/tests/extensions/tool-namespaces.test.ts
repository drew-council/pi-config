import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  buildSessionContext,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { _test as browser } from "../../extensions/browser-log.js";

const root = process.env.WEB_ACCESS_PACKAGE_ROOT ?? `${import.meta.dir}/../../npm/node_modules/pi-web-access`;
const runtimeTest = existsSync(`${root}/package.json`) ? test : test.skip;
const names = {
  webSearch: "web_search",
  sourceCheck: "source_check",
  fetchContent: "fetch_content",
  getSearchContent: "get_search_content",
};

// Execute the installed registration and activation code, substituting only network-producing executors.
function webRegistration(pi: ExtensionAPI, source = false) {
  const bundle = readFileSync(`${root}/dist/index.js`, "utf8");
  const text = source
    ? new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(`${root}/index.ts`, "utf8"))
    : bundle;
  const start = text.indexOf(`${source ? "const" : "var"} registerStructuredTool =`);
  const wrapper = text.slice(start, text.indexOf("const webSearchEnabled", start));
  const register = runInNewContext(`${wrapper}\nregisterStructuredTool`, {
    pi,
    toolNames: names,
    webOutputSchema: Type.Object({ ok: Type.Boolean() }),
    structuredWebResult: () => ({
      content: [{ type: "text", text: "offline" }],
      details: {},
      structuredContent: { ok: true },
    }),
    getResult: () => undefined,
    getMaxInlineContentChars: () => 1000,
    initConfig: {},
    fetchModeConfig: { defaultMode: "readable" },
    isAbortError: () => false,
  });
  // Disabled capabilities are not registered, not merely removed from the active set.
  for (const name of [names.webSearch, names.fetchContent, names.getSearchContent]) {
    register({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
  }
  for (const enabled of ["webSearchEnabled", "sourceCheckEnabled", "fetchContentEnabled"]) {
    assert.match(text, new RegExp(`if \\(${enabled}\\)\\s+registerStructuredTool\\(\\{`));
  }
  assert.match(text, /getSearchContentEnabled\) \{[\s\S]*?registerStructuredTool\(\{/);
  const activationText = source
    ? new Bun.Transpiler({ loader: "ts" })
        .transformSync(readFileSync(`${root}/tool-activation.ts`, "utf8"))
        .replace(/^import .*;$/gm, "")
        .replace(/^export /gm, "")
    : bundle.slice(
        bundle.indexOf('var LOADER_NAME = "web_enable"'),
        bundle.indexOf("//", bundle.indexOf("function registerWebToolActivation(pi")),
      );
  const activate = runInNewContext(`${activationText}\nregisterWebToolActivation`, {
    Type,
    buildSessionContext,
    console,
  });
  activate(
    pi,
    [
      { name: names.webSearch, capability: "search" },
      { name: names.fetchContent, capability: "fetch" },
      { name: names.getSearchContent, capability: "stored-content" },
    ],
    "dynamic",
  );
}

runtimeTest("web namespace/exposure/annotations match source and the loaded dist", () => {
  const capture = (source: boolean) => {
    const tools: ToolDefinition[] = [];
    webRegistration(
      {
        registerTool: (tool) => tools.push(tool),
        on: () => () => {},
        getAllTools: () => tools,
        getActiveTools: () => [],
        setActiveTools: () => {},
      } as unknown as ExtensionAPI,
      source,
    );
    return tools.map(({ name, exposure, namespace, annotations, parameters, outputSchema }) => ({
      name,
      exposure,
      namespace,
      annotations,
      parameters,
      outputSchema,
    }));
  };
  assert.equal(JSON.stringify(capture(true)), JSON.stringify(capture(false)));
  for (const tool of capture(false)) {
    assert.equal(tool.namespace.name, "web");
    assert.match(tool.namespace.instructions, /disabled capabilities stay unavailable/);
    assert.equal(tool.exposure, tool.name === "web_enable" ? "model-only" : "direct");
    assert.equal(tool.annotations.destructiveHint, false);
  }
});

async function execute(session: AgentSession, name: string, args: JsonObject) {
  const id = `namespace-${session.sessionManager.getEntries().length}`;
  session.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "namespace-test",
    content: [{ type: "toolCall", id, name, arguments: args }],
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
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be declared`);
  return tool.execute(id, args, new AbortController().signal);
}

for (const mode of ["on", "only"] as const) {
  runtimeTest(
    `namespaces respect lazy activation, disabled tools, stable declarations and direct browser selection (${mode})`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-tool-namespaces-"));
      let session: AgentSession | undefined;
      let api: ExtensionAPI;
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
            (pi) => {
              api = pi;
              webRegistration(pi);
              pi.registerTool(browser.createBrowserLogTool());
            },
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
        assert.ok(session.getActiveToolNames().includes("web_enable"));
        assert.ok(!session.getCallableToolNames().includes("web_enable"));
        assert.ok(!session.getCallableToolNames().includes("web_search"));
        const before = await execute(session, "codemode", {
          code: 'if (await describeTool("web_search")) throw new Error("lazy bypass"); if (await describeTool("source_check")) throw new Error("disabled bypass"); return "inactive";',
        });
        assert.match(JSON.stringify(before), /Script completed/);
        await execute(session, "web_enable", {});
        assert.ok(session.getCallableToolNames().includes("web_search"));
        assert.ok(!session.getCallableToolNames().includes("source_check"));
        const code =
          'const ns = await describeNamespace("web"); if (!ns.instructions.includes("human approval")) throw new Error("missing guidance"); const found = await searchTools("search", {namespace: "web"}); if (!found.some(t => t.name === "web_search")) throw new Error("undiscoverable"); if (ALL_TOOLS.some(t => t.name === "web_enable" || t.name === "source_check")) throw new Error("exposure bypass"); const value = await tools.web_search({}); if (!value.ok) throw new Error("structured result lost"); return (await describeTool("web_search"));';
        const discovered = await execute(session, "codemode", { code });
        assert.match(JSON.stringify(discovered), /Script completed/);
        assert.match(JSON.stringify(discovered), /web_search/);
        const repeated = await execute(session, "codemode", { code });
        // Wall time is variable; declarations and output are not.
        const texts = (value: typeof discovered) =>
          value.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .replace(/Wall time [^\n]+/g, "Wall time TIME");
        assert.equal(texts(discovered), texts(repeated));
        api.setActiveTools(api.getActiveTools().filter((name) => name !== "capture_browser_log"));
        assert.ok(!session.getCallableToolNames().includes("capture_browser_log"));
        const disabled = await execute(session, "codemode", {
          code: 'if (await describeTool("capture_browser_log")) throw new Error("browser disabled bypass"); if (ALL_TOOLS.some(t => t.name === "capture_browser_log")) throw new Error("browser callable"); return "disabled";',
        });
        assert.match(JSON.stringify(disabled), /Script completed/);
        api.setActiveTools([...api.getActiveTools(), "capture_browser_log"]);
        const browserDiscovery = await execute(session, "codemode", {
          code: 'const ns = await describeNamespace("browser"); if (!ns.instructions.includes("JSON report")) throw new Error("missing browser guidance"); return await describeTool("capture_browser_log");',
        });
        assert.match(JSON.stringify(browserDiscovery), /Script completed/);
        assert.match(JSON.stringify(browserDiscovery), /filePath/);
        for (const common of ["read", "bash", "edit", "write"])
          assert.ok(session.getCallableToolNames().includes(common));
      } finally {
        session?.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test("browser metadata is conservative about report writes and preserves direct disablement", () => {
  const tool = browser.createBrowserLogTool();
  assert.equal(tool.exposure, "direct");
  assert.equal(tool.namespace.name, "browser");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("installed subagent orchestration registrations retain model-only helper metadata", async () => {
  const packageRoot = `${import.meta.dir}/../../npm/node_modules/pi-subagents`;
  const helper = await import(`${packageRoot}/src/shared/extension-context.js`);
  assert.equal(helper.MODEL_ONLY_TOOL.exposure, "model-only");
  for (const name of [
    "extension/index",
    "extension/tool-activation",
    "extension/fanout-child",
    "extension/herdr-pi-bridge",
    "intercom/native-supervisor-channel",
  ]) {
    const source = readFileSync(`${packageRoot}/src/${name}.js`, "utf8");
    assert.match(source, /import.*MODEL_ONLY_TOOL/);
    assert.match(source, /\.\.\.MODEL_ONLY_TOOL/);
  }
});
