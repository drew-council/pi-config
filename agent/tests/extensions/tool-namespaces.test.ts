import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { _test as browser } from "../../extensions/browser-log.js";

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
  test(`namespaces respect disabled tools and direct browser selection (${mode})`, async () => {
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
  });
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
