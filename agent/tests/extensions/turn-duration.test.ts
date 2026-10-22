import assert from "node:assert/strict";
import test from "node:test";
import type { StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import turnDurationExtension, { formatTurnCompletion } from "../../extensions/turn-duration.js";

function createHarness(
  initialTime = new Date(2026, 3, 19, 10, 31, 47).getTime(),
  mode: ExtensionContext["mode"] = "tui",
) {
  let currentTime = initialTime;
  let idle = true;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void>();
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];

  const ctx = {
    mode,
    isIdle: () => idle,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  turnDurationExtension(
    {
      on: (event: string, handler: (event: any, ctx: ExtensionContext) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    } as unknown as ExtensionAPI,
    () => currentTime,
  );

  return {
    notifications,
    advanceMs(ms: number) {
      currentTime += ms;
    },
    setIdle(nextIdle: boolean) {
      idle = nextIdle;
    },
    emit(event: string, payload: Record<string, unknown> = {}) {
      handlers.get(event)?.({ type: event, ...payload }, ctx);
    },
    assistantMessageEnd(stopReason: StopReason = "stop") {
      handlers.get("message_end")?.({ type: "message_end", message: { role: "assistant", stopReason } }, ctx);
    },
  };
}

test("formatTurnCompletion formats the Pi completion line", () => {
  const completedAt = new Date(2026, 3, 19, 11, 14, 0);
  assert.equal(formatTurnCompletion((42 * 60 + 13) * 1_000, completedAt), "π Worked for 42m 13s · done 11:14 AM");
});

test("turn-duration emits an info notification when a run settles across multiple continuations", () => {
  const h = createHarness(new Date(2026, 3, 19, 10, 31, 47).getTime());

  h.emit("session_start");
  h.emit("before_agent_start");
  h.advanceMs(2_000);
  h.emit("agent_start");
  h.advanceMs(20 * 60 * 1_000);
  h.assistantMessageEnd("error");
  // Continuation / retry within the same run should keep the original start time.
  h.emit("agent_start");
  h.advanceMs((22 * 60 + 11) * 1_000);
  h.assistantMessageEnd("stop");
  h.emit("agent_settled", { aborted: false });

  assert.deepEqual(h.notifications, [
    {
      message: "π Worked for 42m 13s · done 11:14 AM",
      type: "info",
    },
  ]);
});

test("turn-duration suppresses notifications on abort, final error, or non-TUI modes", () => {
  const h = createHarness();

  h.emit("before_agent_start");
  h.advanceMs(5_000);
  h.assistantMessageEnd("aborted");
  h.emit("agent_settled", { aborted: true });
  assert.equal(h.notifications.length, 0);

  h.emit("before_agent_start");
  h.advanceMs(8_000);
  h.assistantMessageEnd("error");
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 0);

  const rpc = createHarness(undefined, "rpc");
  rpc.emit("before_agent_start");
  rpc.advanceMs(5_000);
  rpc.assistantMessageEnd("stop");
  rpc.emit("agent_settled", { aborted: false });
  assert.equal(rpc.notifications.length, 0);
});
