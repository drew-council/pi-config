import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { _test, profileColumns, profileSnapshotLines, type Snapshot } from "../../extensions/usage/index.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const snapshot = {
  codex: { status: "error" as const, message: "codex-only" },
  copilot: { status: "error" as const, message: "copilot-only" },
  claude: { status: "error" as const, message: "claude-only" },
  openrouter: { status: "error" as const, message: "router-only" },
  fetchedAt: 0,
};

test("usage columns contain only their profile's providers, even for errors", () => {
  const work = profileSnapshotLines(snapshot, theme, "work").join("\n");
  const personal = profileSnapshotLines(snapshot, theme, "personal").join("\n");
  expect(work).toContain("copilot-only");
  expect(work).toContain("claude-only");
  expect(work).toContain("Google Gemini");
  expect(work).not.toContain("codex-only");
  expect(work).not.toContain("router-only");
  expect(personal).toContain("codex-only");
  expect(personal).toContain("router-only");
  expect(personal).not.toContain("copilot-only");
  expect(personal).not.toContain("claude-only");
  for (const width of [1, 20, 80, 160]) {
    const lines = profileColumns(snapshot, theme, width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
  }
  const lines = profileColumns(snapshot, theme, 80);
  expect(lines[0]).toMatch(/WORK.*│.*PERSONAL/);
  expect(lines.join("\n")).toContain("codex-only");
});

test("metrics keep percentages intact and reset times separate at normal terminal widths", () => {
  const data: Snapshot = {
    ...snapshot,
    claude: {
      status: "ok",
      data: {
        subscription: "max",
        extraUsageSummary: null,
        limits: [
          { label: "weekly · all models", usedPercent: 17, resetsAt: "2026-09-16T12:00:00Z", severity: "normal" },
        ],
      },
    },
  };
  for (const width of [60, 80, 120, 160]) {
    const lines = profileColumns(data, theme, width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
    const percentLine = lines.find((line) => line.includes("83% left"));
    expect(percentLine).toBeDefined();
    expect(percentLine).not.toContain("Resets");
    expect(lines.some((line) => line.includes("Resets"))).toBeTrue();
  }
  const narrow = profileColumns(data, theme, 40).join("\n");
  expect(narrow.indexOf("PERSONAL")).toBeGreaterThan(narrow.indexOf("Google Gemini"));
});

test("usage reads each owning profile without global or opposite-profile fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
  const save = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value));
  const codex = (access: string) => ({ access });
  const copilot = (refresh: string) => ({ type: "oauth", refresh });
  try {
    mkdirSync(join(dir, "auth-profiles"));
    save("auth-profiles.json", { activeProfile: "work" });
    save("auth.json", { "openai-codex": codex("global"), "github-copilot": copilot("global") });
    save("auth-profiles/work.json", { "github-copilot": copilot("work"), "openai-codex": codex("wrong") });
    save("auth-profiles/personal.json", { "openai-codex": codex("personal"), "github-copilot": copilot("wrong") });
    expect((await _test.readCodexCredentials(dir))?.access).toBe("personal");
    expect((await _test.readCopilotCredentials(dir))?.refreshToken).toBe("work");
    save("auth-profiles/personal.json", {});
    expect(await _test.readCodexCredentials(dir)).toBeNull();
    save("auth-profiles/work.json", {});
    expect(await _test.readCopilotCredentials(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
