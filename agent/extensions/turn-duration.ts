import type { StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatClockTime, formatDuration } from "./shared/time.js";

export function formatTurnCompletion(durationMs: number, completedAt: Date | number): string {
  return `π Worked for ${formatDuration(durationMs)} · done ${formatClockTime(completedAt)}`;
}

export default function turnDurationExtension(pi: ExtensionAPI, now: () => number = Date.now) {
  let startedAt: number | undefined;
  let lastStopReason: StopReason | undefined;

  const reset = (active = false) => {
    startedAt = active ? now() : undefined;
    lastStopReason = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    reset(!ctx.isIdle());
  });

  pi.on("session_shutdown", () => {
    reset();
  });

  pi.on("before_agent_start", () => {
    startedAt ??= now();
  });

  pi.on("agent_start", () => {
    startedAt ??= now();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      lastStopReason = event.message.stopReason;
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    const runStartedAt = startedAt;
    const stopReason = lastStopReason;
    reset();

    if (ctx.mode !== "tui" || event.aborted || runStartedAt === undefined) return;
    if (stopReason === "aborted" || stopReason === "error") return;

    const completedAt = now();
    ctx.ui.notify(formatTurnCompletion(completedAt - runStartedAt, completedAt), "info");
  });
}
