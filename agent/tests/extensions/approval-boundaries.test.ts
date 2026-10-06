import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import askUser from "../../extensions/ask-user/index.js";
import { registerCheckpointTool } from "../../npm/node_modules/@bizmyth/pi-address-review-comments/src/checkpoint-tool.js";
import addressReviewComments from "../../npm/node_modules/@bizmyth/pi-address-review-comments/src/index.js";

const approvalTools = ["ask_user", "github_review_checkpoint"];

test("approval registrations retain sequential execution and UI renderers", () => {
  const tools: ToolDefinition[] = [];
  const pi = {
    on: () => {},
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI;
  askUser(pi);
  registerCheckpointTool(pi, {
    getWorkflow: () => undefined,
    isTerminal: () => false,
    finish: () => {},
    markTerminal: () => false,
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    approvalTools,
  );
  for (const tool of tools) {
    assert.equal(tool.exposure, "model-only");
    assert.equal(tool.executionMode, "sequential");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
});

async function execute(session: AgentSession, name: string, args: JsonObject) {
  const id = `approval-${session.sessionManager.getEntries().length}`;
  session.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "approval-test",
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
  assert.ok(tool, `${name} must remain declared directly`);
  return tool.execute(id, args, new AbortController().signal);
}

for (const mode of ["on", "only"] as const) {
  test(`approval tools stay direct and reject nested/codemode calls (${mode})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-approval-boundaries-"));
    let session: AgentSession | undefined;
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
          askUser,
          addressReviewComments,
          (pi) =>
            pi.registerTool({
              name: "approval_probe",
              label: "Approval probe",
              description: "Test nested approval rejection",
              parameters: Type.Object({}),
              async execute(_id, _args, _signal, _update, ctx) {
                for (const name of approvalTools) {
                  assert.ok(!ctx.tools.some((tool) => tool.name === name));
                  const outcome = await ctx.executeTool(name, {});
                  assert.equal(outcome.isError, true);
                  assert.match(JSON.stringify(outcome.result), /not found|unknown tool/i);
                }
                return { content: [{ type: "text", text: "nested approval calls rejected" }], details: undefined };
              },
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
      const sessionManager = SessionManager.inMemory(directory);
      // Restore an existing branch workflow; never fetch a PR or contact GitHub.
      sessionManager.appendCustomEntry("github-review-comments-state", {
        active: true,
        repoRoot: directory,
        repository: "test/repo",
        githubUsername: "supervisor",
        prNumber: 1,
        threadIds: ["thread-1"],
      });
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        modelRuntime,
        sessionManager,
      }));
      initTheme("dark", false);
      await session.bindExtensions({});
      for (const name of approvalTools) {
        assert.ok(session.getActiveToolNames().includes(name));
        assert.ok(session.agent.state.tools.some((tool) => tool.name === name));
        assert.ok(!session.getCallableToolNames().includes(name));
        const definition = session.getAllTools().find((tool) => tool.name === name);
        assert.equal(definition?.exposure, "model-only");
      }
      assert.match(JSON.stringify(await execute(session, "approval_probe", {})), /nested approval calls rejected/);
      const script = await execute(session, "codemode", {
        code: `
        for (const name of ${JSON.stringify(approvalTools)}) {
          if (ALL_TOOLS.some(tool => tool.name === name)) throw new Error("approval tool listed");
          if (await describeTool(name)) throw new Error("approval tool described");
          try { await tools[name]({}); throw new Error("approval tool reachable"); }
          catch (error) { if (error.message === "approval tool reachable") throw error; }
        }
        return "codemode approval calls rejected";
      `,
      });
      assert.match(JSON.stringify(script), /Script completed/);
      assert.match(JSON.stringify(script), /codemode approval calls rejected/);
      // Direct calls still reach the original headless UI guards, not nested-tool rejection.
      assert.match(
        JSON.stringify(await execute(session, "ask_user", { question: "Proceed?" })),
        /Ask requires interactive mode/,
      );
      await assert.rejects(
        execute(session, "github_review_checkpoint", {
          threadId: "thread-1",
          location: "file:1",
          checkpointMarkdown: "Summary",
          draftReply: "Reply",
        }),
        /human approval is mandatory/,
      );
    } finally {
      session?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
