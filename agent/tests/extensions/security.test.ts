import { test } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ReviewFn, ReviewVerdict } from "../../extensions/security/review.js";

// This hook only classifies paths; it never reads/writes the real agent directory.
// Avoid replacing the entire SDK module for every other test in Bun's process.
const TEST_AGENT_DIR = getAgentDir();
const { createSecurityExtension } = await import("../../extensions/security/index.js");

type ToolCallResult = { block: true; reason: string } | undefined;
type ConfirmOptions = { signal?: AbortSignal } | undefined;
type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: {
    cwd: string;
    hasUI: boolean;
    ui: {
      confirm(title: string, message: string, opts?: ConfirmOptions): Promise<boolean>;
      notify(message: string, level: string): void;
    };
  },
) => Promise<ToolCallResult>;

const noReviewer: ReviewFn = async () => {
  throw new Error("no reviewer in test");
};

function registerSecurityHook(
  emittedEvents: Array<{ name: string; data: unknown }> = [],
  review: ReviewFn = noReviewer,
): ToolCallHandler {
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

  createSecurityExtension(pi as unknown as ExtensionAPI, { review });
  assert.ok(handler, "security extension should register a tool_call hook");
  return handler;
}

/**
 * `confirm: undefined` leaves the dialog open until its signal aborts, which
 * mirrors Pi resolving `false` when an extension dismisses the dialog. A
 * function simulates a user who answers after some delay.
 */
function context(options: { cwd?: string; hasUI?: boolean; confirm?: boolean | (() => Promise<boolean>) } = {}) {
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    confirmations,
    notifications,
    ctx: {
      cwd: options.cwd ?? "/workspace/project",
      hasUI: options.hasUI ?? false,
      ui: {
        confirm(title: string, message: string, opts?: ConfirmOptions) {
          confirmations.push({ title, message });
          if (typeof options.confirm === "function") return options.confirm();
          if (options.confirm !== undefined) return Promise.resolve(options.confirm);
          return new Promise<boolean>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
          });
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

const verdict =
  (decision: ReviewVerdict["decision"], reason = "test verdict"): ReviewFn =>
  async () => ({ decision, reason });

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
  assert.equal(
    headless?.reason,
    "Blocked destructive git reset (no UI to confirm; reviewer unavailable: no reviewer in test)",
  );

  const denied = context({ hasUI: true, confirm: false });
  assert.equal(
    (await runBash(handler, "git reset --hard HEAD", denied.ctx))?.reason,
    "Blocked destructive git reset by user",
  );
  assert.equal(denied.confirmations.length, 1);

  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const eventHandler = registerSecurityHook(emittedEvents);
  const eventContext = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(eventHandler, "git push --force origin main", eventContext.ctx), undefined);
  assert.deepEqual(emittedEvents, [
    { name: "herdr:blocked", data: { active: true, label: "Waiting for command confirmation" } },
    { name: "herdr:blocked", data: { active: false } },
  ]);

  const approved = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(handler, "git reset --hard HEAD", approved.ctx), undefined);
  assert.equal(approved.confirmations.length, 1);
});

test("gcloud commands go through the confirm gate", async () => {
  const handler = registerSecurityHook();

  assert.equal(
    (await runBash(handler, "gcloud projects list"))?.reason,
    "Blocked gcloud command (no UI to confirm; reviewer unavailable: no reviewer in test)",
  );
  assert.match(
    (await runBash(handler, "cd infra && gcloud run deploy api --source ."))?.reason ?? "",
    /gcloud command/,
  );

  const gates: string[] = [];
  const approving = registerSecurityHook([], async (_ctx, request) => {
    gates.push(request.gate.detection);
    return { decision: "approve", reason: "read-only listing" };
  });
  assert.equal(await runBash(approving, "gcloud run services list"), undefined);
  assert.match(gates[0] ?? "", /Google Cloud/);
});

test("sudo is always hard-blocked without a prompt", async () => {
  const handler = registerSecurityHook([], verdict("approve"));

  const interactive = context({ hasUI: true, confirm: true });
  const blocked = await runBash(handler, "sudo reboot", interactive.ctx);
  assert.match(blocked?.reason ?? "", /sudo is never allowed/);
  assert.equal(interactive.confirmations.length, 0);
  assert.equal(interactive.notifications[0]?.level, "warning");

  assert.match((await runBash(handler, "sudo rm -rf /tmp/x"))?.reason ?? "", /sudo is never allowed/);
});

test("the background reviewer dismisses the dialog when it approves", async () => {
  const seen: Array<{ command: string; gate: string; cwd: string }> = [];
  const handler = registerSecurityHook([], async (_ctx, request) => {
    seen.push({ ...request, gate: request.gate.name });
    return { decision: "approve", reason: "scratch dir under /tmp" };
  });

  const pending = context({ hasUI: true });
  assert.equal(await runBash(handler, "cd /tmp && rm -rf scratch", pending.ctx), undefined);
  assert.equal(pending.confirmations.length, 1);
  assert.deepEqual(seen, [
    { command: "cd /tmp && rm -rf scratch", gate: "recursive delete", cwd: "/workspace/project" },
  ]);
  assert.deepEqual(pending.notifications, [
    { message: "Auto-approved recursive delete: scratch dir under /tmp", level: "info" },
  ]);
});

test("the background reviewer leaves the decision to the user when unsure", async () => {
  const handler = registerSecurityHook([], verdict("ask_user", "target is a source tree"));

  const denied = context({ hasUI: true, confirm: false });
  assert.equal((await runBash(handler, "rm -rf src", denied.ctx))?.reason, "Blocked recursive delete by user");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(denied.notifications, [
    { message: "Reviewer wants your decision: target is a source tree", level: "warning" },
  ]);

  const approved = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(handler, "rm -rf src", approved.ctx), undefined);
});

test("a user answer cancels the background review", async () => {
  let reviewSignal: AbortSignal | undefined;
  const handler = registerSecurityHook([], (_ctx, _request, signal) => {
    reviewSignal = signal;
    return new Promise<ReviewVerdict>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });

  const approved = context({ hasUI: true, confirm: true });
  assert.equal(await runBash(handler, "rm -rf src", approved.ctx), undefined);
  assert.equal(reviewSignal?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(approved.notifications, []);
});

test("reviewer failures only notify while the dialog stays open", async () => {
  const handler = registerSecurityHook([], async () => {
    throw new Error("model offline");
  });

  const slowUser = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5));
  const denied = context({ hasUI: true, confirm: slowUser });
  assert.equal((await runBash(handler, "rm -rf src", denied.ctx))?.reason, "Blocked recursive delete by user");
  assert.deepEqual(denied.notifications, [
    { message: "Command reviewer unavailable: model offline", level: "warning" },
  ]);

  // Once the user has answered, a late failure is not worth a notification.
  const quickUser = context({ hasUI: true, confirm: false });
  assert.equal((await runBash(handler, "rm -rf src", quickUser.ctx))?.reason, "Blocked recursive delete by user");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(quickUser.notifications, []);
});

test("without a UI the reviewer decides", async () => {
  const approving = registerSecurityHook([], verdict("approve", "user asked for it"));
  assert.equal(await runBash(approving, "rm -rf build"), undefined);

  const unsure = registerSecurityHook([], verdict("ask_user", "target not mentioned"));
  assert.equal(
    (await runBash(unsure, "rm -rf build"))?.reason,
    "Blocked recursive delete (no UI to confirm; reviewer: target not mentioned)",
  );
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
