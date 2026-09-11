import { test } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

// This hook only classifies paths; it never reads/writes the real agent directory.
// Avoid replacing the entire SDK module for every other test in Bun's process.
const TEST_AGENT_DIR = getAgentDir();
const { default: securityExtension } = await import("../../extensions/security.js");

type ToolCallResult = { block: true; reason: string } | undefined;
type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: {
    cwd: string;
    hasUI: boolean;
    ui: {
      confirm(title: string, message: string): Promise<boolean>;
      notify(message: string, level: string): void;
    };
  },
) => Promise<ToolCallResult>;

function registerSecurityHook(emittedEvents: Array<{ name: string; data: unknown }> = []): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    events: {
      emit(name: string, data: unknown) {
        emittedEvents.push({ name, data });
      },
    },
    on(event: string, candidate: ToolCallHandler) {
      if (event === "tool_call") handler = candidate;
    },
  };

  securityExtension(pi as unknown as ExtensionAPI);
  assert.ok(handler, "security extension should register a tool_call hook");
  return handler;
}

function context(options: { cwd?: string; hasUI?: boolean; confirm?: boolean } = {}) {
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    confirmations,
    notifications,
    ctx: {
      cwd: options.cwd ?? "/workspace/project",
      hasUI: options.hasUI ?? false,
      ui: {
        async confirm(title: string, message: string) {
          confirmations.push({ title, message });
          return options.confirm ?? false;
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

async function runBash(handler: ToolCallHandler, command: string, ctx = context().ctx) {
  return handler({ toolName: "bash", input: { command } }, ctx);
}

async function runWrite(handler: ToolCallHandler, filePath: string, ctx = context().ctx) {
  return handler({ toolName: "write", input: { path: filePath } }, ctx);
}

test("recursive delete protection distinguishes verified temporary paths from unsafe targets", async () => {
  const handler = registerSecurityHook();

  assert.match((await runBash(handler, "rm -rf build"))?.reason ?? "", /recursive delete/);
  assert.match(
    (await runBash(handler, "rm --recursive --force /tmp/safe /workspace/data"))?.reason ?? "",
    /recursive delete/,
  );
  assert.equal(await runBash(handler, 'rm -rf "$TMP_DIR"'), undefined);

  assert.equal(await runBash(handler, "rm -rf /tmp/pi-security-test"), undefined);
  assert.equal(await runBash(handler, 'TMP_DIR=$(mktemp -d); rm -rf "$TMP_DIR"'), undefined);
  assert.match(
    (await runBash(handler, 'TMP_DIR=/workspace/data; rm -rf "$TMP_DIR"'))?.reason ?? "",
    /recursive delete/,
  );
});

test("dangerous commands require an affirmative UI confirmation", async () => {
  const handler = registerSecurityHook();

  const headless = await runBash(handler, "git reset --hard HEAD");
  assert.equal(headless?.reason, "Blocked destructive git reset (no UI to confirm)");

  const denied = context({ hasUI: true, confirm: false });
  assert.equal(
    (await runBash(handler, "git reset --hard HEAD", denied.ctx))?.reason,
    "Blocked destructive git reset by user",
  );
  assert.equal(denied.confirmations.length, 1);

  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const eventHandler = registerSecurityHook(emittedEvents);
  const eventContext = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(eventHandler, "sudo reboot", eventContext.ctx), undefined);
  assert.deepEqual(emittedEvents, [
    { name: "herdr:blocked", data: { active: true, label: "Waiting for command confirmation" } },
    { name: "herdr:blocked", data: { active: false } },
  ]);

  const approved = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(handler, "git reset --hard HEAD", approved.ctx), undefined);
  assert.equal(approved.confirmations.length, 1);
});

test("write protection covers secrets and lockfiles while allowing intentional package patches", async () => {
  const handler = registerSecurityHook();

  assert.equal((await runWrite(handler, ".env.local"))?.reason, "Protected path: environment file");
  assert.equal(await runWrite(handler, ".env.example"), undefined);
  assert.equal((await runWrite(handler, "bun.lock"))?.reason, "Protected path (no UI): Bun lockfile");

  const approved = context({ hasUI: true, confirm: true });
  assert.equal(await runWrite(handler, "agent/bun.lock", approved.ctx), undefined);
  assert.equal(approved.confirmations[0]?.title, "Modifying Bun lockfile");

  const managedPackageFile = path.join(TEST_AGENT_DIR, "npm", "node_modules", "example-package", "index.js");
  assert.equal(await runWrite(handler, managedPackageFile), undefined);
  assert.equal(
    (await runWrite(handler, "/workspace/project/node_modules/example-package/index.js"))?.reason,
    "Protected path: node_modules",
  );
});

test("git commits may not attribute an AI co-author", async () => {
  const handler = registerSecurityHook();
  const approved = context({ hasUI: true, confirm: true });

  const blocked = await runBash(
    handler,
    'git commit -m "fix thing\n\nCo-authored-by: Claude <noreply@anthropic.com>"',
    approved.ctx,
  );
  assert.match(blocked?.reason ?? "", /Do not attribute commits to yourself/);

  assert.match(
    (await runBash(handler, 'git commit -m "feat: x\n\nGenerated with Codex"', approved.ctx))?.reason ?? "",
    /Do not attribute commits to yourself/,
  );

  assert.equal(await runBash(handler, 'git commit -m "fix thing"', approved.ctx), undefined);
  assert.equal(
    await runBash(handler, 'git commit -m "fix\n\nCo-authored-by: Drew <drew@example.com>"', approved.ctx),
    undefined,
  );
  assert.equal(await runBash(handler, 'echo "Generated with Claude Code"', approved.ctx), undefined);
});
