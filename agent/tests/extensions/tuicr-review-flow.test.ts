import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import tuicrReviewExtension from "../../extensions/tuicr-review/index.js";

const REVIEW_TWO = `## Local tuicr Comments

1. **[ISSUE]** \`src/a.ts:1\` - First problem

2. **[NITPICK]** \`src/b.ts:2\` - Second problem
`;

const REVIEW_ONE = `## Local tuicr Comments

1. **[ISSUE]** \`src/c.ts:9\` - Replacement problem
`;

interface HarnessOptions {
  clipboard?: string;
  idle?: boolean;
  /** Which comments the selection dialog picks: all of them or just the cursor's. */
  selection?: "all" | "first";
}

function createHarness(options: HarnessOptions = {}) {
  let clipboard = options.clipboard ?? "";
  let execCalls = 0;
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, () => Promise<void>>();
  let resolveIdle: (() => void) | undefined;
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sent: string[] = [];
  const deliveries: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const pi = {
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, definition);
    },
    on(event: string, handler: () => Promise<void>) {
      handlers.set(event, handler);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    async exec() {
      execCalls += 1;
      return { code: 0, stdout: clipboard, stderr: "" };
    },
    sendUserMessage(message: string, options?: { deliverAs?: string }) {
      sent.push(message);
      deliveries.push(options?.deliverAs);
    },
  };

  tuicrReviewExtension(pi as unknown as ExtensionAPI);

  const ctx = {
    cwd: "/workspace/repo",
    hasUI: true,
    mode: "tui",
    isIdle: () => options.idle ?? true,
    waitForIdle: () =>
      new Promise<void>((resolve) => {
        resolveIdle = resolve;
      }),
    ui: {
      theme,
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (_id: string, value?: string) => statuses.push(value),
      custom: async (factory: unknown) => {
        return await new Promise((resolve) => {
          const done = (value: unknown) => resolve(value);
          const component = (
            factory as (
              tui: unknown,
              theme: unknown,
              keybindings: unknown,
              done: (value: unknown) => void,
            ) => { handleInput: (data: string) => void }
          )({ requestRender() {} }, theme, {}, done);
          const keys = options.selection === "first" ? [" ", "\r"] : ["a", "\r"];
          for (const key of keys) component.handleInput(key);
        });
      },
      editor: async () => "",
    },
    sessionManager: { getBranch: () => [] },
  };

  return {
    deliveries,
    entries,
    notifications,
    sent,
    statuses,
    lastState: () => {
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.customType === "tuicr-review-state") return entry.data as { addressedIds: string[] } | undefined;
      }
      return undefined;
    },
    execCalls: () => execCalls,
    emit: async (event: string) => {
      await handlers.get(event)?.();
    },
    settle: () => resolveIdle?.(),
    setClipboard: (value: string) => {
      clipboard = value;
    },
    run: async (args: string) => {
      const command = commands.get("tuicr");
      assert.ok(command, "the extension should register the tuicr command");
      await command.handler(args, ctx as unknown as ExtensionCommandContext);
    },
  };
}

test("bare /tuicr parses the clipboard into the queue and starts a round", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO });

  await harness.run("");

  assert.equal(harness.execCalls(), 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0] ?? "", /src\/a\.ts:1/);
  assert.match(harness.sent[0] ?? "", /src\/b\.ts:2/);
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1", "comment-2"]);
  assert.ok(harness.notifications.some((entry) => /Parsed 2 comments/.test(entry.message)));
});

test("bare /tuicr resumes the queue without touching the clipboard", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO, selection: "first" });

  await harness.run("");
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1"]);

  harness.setClipboard(REVIEW_ONE);
  await harness.run("");

  assert.equal(harness.execCalls(), 1, "resuming should not read the clipboard");
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1] ?? "", /src\/b\.ts:2/);
  assert.doesNotMatch(harness.sent[1] ?? "", /src\/c\.ts:9/);
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1", "comment-2"]);
});

test("draining the queue lets the next bare /tuicr parse the clipboard again", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO });

  await harness.run("");
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1", "comment-2"]);

  harness.setClipboard(REVIEW_ONE);
  await harness.run("");

  assert.equal(harness.execCalls(), 2, "an empty queue should fall back to the clipboard");
  assert.match(harness.sent[1] ?? "", /src\/c\.ts:9/);
});

test("/tuicr clear discards the queue and the next bare /tuicr reparses", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO, selection: "first" });

  await harness.run("");
  await harness.run("clear");

  assert.equal(harness.lastState(), undefined);
  assert.equal(harness.statuses.at(-1), undefined);
  assert.ok(harness.notifications.some((entry) => /Cleared the queued tuicr review/.test(entry.message)));

  harness.setClipboard(REVIEW_ONE);
  await harness.run("");

  assert.equal(harness.execCalls(), 2);
  assert.match(harness.sent[1] ?? "", /src\/c\.ts:9/);
});

test("bare /tuicr reports an error when the clipboard has no review", async () => {
  const harness = createHarness({ clipboard: "just some notes" });

  await harness.run("");

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.lastState(), undefined);
  const last = harness.notifications.at(-1);
  assert.equal(last?.level, "error");
  assert.match(last?.message ?? "", /No tuicr comments were found/);
});

test("bare /tuicr queues the prompt as a follow-up while the agent is busy", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO, idle: false });

  await harness.run("");

  assert.equal(harness.execCalls(), 1);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.deliveries, ["followUp"]);
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1", "comment-2"]);
});

test("/tuicr during compaction waits for idle before sending", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO, idle: false });
  await harness.emit("session_before_compact");

  const pending = harness.run("");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sent.length, 0, "nothing should be sent while compacting");
  assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1", "comment-2"]);

  harness.settle();
  await pending;

  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.deliveries, ["followUp"]);
});

test("/tuicr after compaction finishes sends without waiting", async () => {
  const harness = createHarness({ clipboard: REVIEW_TWO });
  await harness.emit("session_before_compact");
  await harness.emit("session_compact");

  await harness.run("");

  assert.equal(harness.sent.length, 1);
});

test("/tuicr parse <file> queues a review from disk", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuicr-review-"));
  try {
    const reviewPath = path.join(directory, "review.md");
    await writeFile(reviewPath, REVIEW_ONE, "utf8");
    const harness = createHarness();

    await harness.run(`parse ${reviewPath}`);

    assert.equal(harness.execCalls(), 0, "file parsing should not read the clipboard");
    assert.match(harness.sent[0] ?? "", /src\/c\.ts:9/);
    assert.deepEqual(harness.lastState()?.addressedIds, ["comment-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
