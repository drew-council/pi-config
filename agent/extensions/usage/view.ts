import { Box, type Component, Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ProfileName, providerAllowed } from "../shared/accounts.js";
import { clampPercent, formatMoney, formatResetTime, humanizeSeconds } from "./format.js";
import type { Snapshot } from "./index.js";

export interface UsageTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const text = (value: string) => new Text(value, 0, 0);
const color = (remaining: number) => (remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "success");

/** A metric owns its width; labels and reset times never wrap through its bar. */
function metric(theme: UsageTheme, label: string, remaining: number, detail?: string): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const percent = clampPercent(remaining);
      const value = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% left`;
      const fitted = truncateToWidth(label, Math.max(0, width - value.length - 2), "…");
      const header =
        width >= value.length + 3
          ? fitted +
            " ".repeat(Math.max(1, width - visibleWidth(fitted) - value.length)) +
            theme.fg(color(percent), value)
          : theme.fg(color(percent), value);
      const filled = Math.round((width * percent) / 100);
      const lines = [
        truncateToWidth(header, width),
        theme.fg(color(percent), "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled)),
      ];
      if (detail) lines.push(...text(theme.fg("dim", detail)).render(width));
      return lines;
    },
  };
}

function card(theme: UsageTheme, title: string): Box {
  const box = new Box(1, 0);
  box.addChild(text(theme.bold(title)));
  return box;
}

export function profileView(snapshot: Snapshot, theme: UsageTheme, profile: ProfileName): Component {
  const column = new Container();
  column.addChild(text(theme.fg("accent", theme.bold(profile === "work" ? "WORK" : "PERSONAL"))));
  column.addChild(new Spacer(1));
  const add = (
    title: string,
    result: { status: "error"; message: string } | { status: "ok" } | null,
    build: (box: Box) => void,
  ) => {
    if (!result) return;
    const box = card(theme, title);
    if (result.status === "error") box.addChild(text(theme.fg("muted", `Unavailable · ${result.message}`)));
    else build(box);
    column.addChild(box);
    column.addChild(new Spacer(1));
  };
  const note = (box: Box, value: string) => box.addChild(text(theme.fg("dim", value)));

  if (providerAllowed(profile, "claude-bridge"))
    add("Claude Code", snapshot.claude, (box) => {
      if (snapshot.claude?.status !== "ok") return;
      const data = snapshot.claude.data;
      if (data.subscription) note(box, `Claude ${data.subscription}`);
      for (const limit of data.limits) {
        box.addChild(new Spacer(1));
        box.addChild(
          metric(
            theme,
            limit.label,
            100 - limit.usedPercent,
            limit.resetsAt ? `Resets ${formatResetTime(limit.resetsAt)}` : undefined,
          ),
        );
        if (limit.severity !== "normal") box.addChild(text(theme.fg("error", `Status: ${limit.severity}`)));
      }
      if (data.extraUsageSummary) note(box, data.extraUsageSummary);
    });
  if (providerAllowed(profile, "github-copilot"))
    add("GitHub Copilot", snapshot.copilot, (box) => {
      if (snapshot.copilot?.status !== "ok") return;
      const data = snapshot.copilot.data;
      if (data.plan) note(box, `Copilot ${data.plan}`);
      for (const quota of data.quotas) {
        if (quota.unlimited) {
          note(box, `${quota.label} · Unlimited`);
          continue;
        }
        box.addChild(new Spacer(1));
        box.addChild(metric(theme, quota.label, quota.remainingPercent ?? 100));
        if (quota.creditsUsed !== null)
          note(
            box,
            quota.entitlement !== null
              ? `${quota.creditsUsed.toLocaleString()} / ${quota.entitlement.toLocaleString()} credits used`
              : `${quota.creditsUsed.toLocaleString()} credits used`,
          );
        if (quota.creditsUsed !== null && quota.entitlement !== null)
          note(box, `${formatMoney(quota.creditsUsed / 100)} / ${formatMoney(quota.entitlement / 100)} spent`);
        if (quota.overageCount > 0) note(box, `+${quota.overageCount.toLocaleString()} overage`);
      }
      if (data.resetDate) note(box, `Resets ${data.resetDate}`);
    });
  if (providerAllowed(profile, "google")) {
    const box = card(theme, "Google Gemini");
    note(box, "Usage reporting not supported");
    column.addChild(box);
  }
  if (providerAllowed(profile, "openai-codex"))
    add("OpenAI Codex", snapshot.codex, (box) => {
      if (snapshot.codex?.status !== "ok") return;
      const data = snapshot.codex.data;
      for (const win of data.windows) {
        box.addChild(new Spacer(1));
        box.addChild(
          metric(
            theme,
            `${win.label} window`,
            100 - win.usedPercent,
            win.resetAfterSeconds !== null ? `Resets in ${humanizeSeconds(win.resetAfterSeconds)}` : undefined,
          ),
        );
      }
      if (data.rateLimitReached) box.addChild(text(theme.fg("error", "Rate limit reached")));
      if (data.creditsSummary) note(box, data.creditsSummary);
      if (data.spendControl) {
        const spend = data.spendControl;
        box.addChild(new Spacer(1));
        box.addChild(metric(theme, "Spend control", 100 - spend.usedPercent));
        note(box, `${spend.limit !== null ? formatMoney(spend.limit) : "Unknown limit"} · ${spend.source}`);
        if (spend.resetAfterSeconds !== null) note(box, `Resets in ${humanizeSeconds(spend.resetAfterSeconds)}`);
      }
    });
  if (providerAllowed(profile, "openrouter"))
    add("OpenRouter", snapshot.openrouter, (box) => {
      if (snapshot.openrouter?.status !== "ok") return;
      const data = snapshot.openrouter.data;
      box.addChild(new Spacer(1));
      if (data.limit !== null) {
        box.addChild(
          metric(theme, "Key budget", data.limit > 0 ? ((data.limit - data.usage) / data.limit) * 100 : 100),
        );
        note(
          box,
          `${formatMoney(data.limitRemaining ?? data.limit - data.usage)} left of ${formatMoney(data.limit)}${data.limitReset ? ` · ${data.limitReset}` : ""}`,
        );
      } else note(box, `${formatMoney(data.usage)} used · No key limit`);
      if (data.totalCredits !== null)
        note(
          box,
          `${formatMoney(Math.max(0, data.totalCredits - (data.totalUsage ?? data.usage)))} account credit remaining`,
        );
    });
  return column;
}

/** Pi has vertical containers; this small adapter only composes their rendered columns. */
export function usageColumns(snapshot: Snapshot, theme: UsageTheme): Component {
  const left = profileView(snapshot, theme, "work");
  const right = profileView(snapshot, theme, "personal");
  return {
    invalidate() {
      left.invalidate();
      right.invalidate();
    },
    render(width) {
      if (width <= 0) return [];
      if (width < 60)
        return [...left.render(width), "", ...right.render(width)].map((line) => truncateToWidth(line, width, ""));
      const gap = 5;
      const columnWidth = Math.floor((width - gap) / 2);
      const a = left.render(columnWidth);
      const b = right.render(width - gap - columnWidth);
      return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
        const line = a[i] ?? "";
        // Each column is independently styled, just like a standalone TUI line.
        return `${line}\x1b[0m${" ".repeat(Math.max(0, columnWidth - visibleWidth(line)))}${theme.fg("dim", "  │  ")}\x1b[0m${b[i] ?? ""}`;
      });
    },
  };
}
