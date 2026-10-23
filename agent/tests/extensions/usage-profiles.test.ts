import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  _test,
  applyLocalChatGPTUsage,
  profileColumns,
  profileSnapshotLines,
  type Snapshot,
} from "../../extensions/usage/index.js";
import { appendLocalUsage, emptyLocalUsage, localUsagePath, readLocalUsage } from "../../extensions/usage/local.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const snapshot = {
  chatgpt: { status: "error" as const, message: "chatgpt-only" },
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
  expect(work).toContain("Google Vertex AI");
  expect(work).not.toContain("chatgpt-only");
  expect(work).not.toContain("router-only");
  expect(personal).toContain("chatgpt-only");
  expect(personal).toContain("router-only");
  expect(personal).not.toContain("copilot-only");
  expect(personal).not.toContain("claude-only");
  for (const width of [1, 20, 80, 160]) {
    const lines = profileColumns(snapshot, theme, width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
  }
  const lines = profileColumns(snapshot, theme, 80);
  expect(lines[0]).toMatch(/WORK.*│.*PERSONAL/);
  expect(lines.join("\n")).toContain("chatgpt-only");
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
  expect(narrow.indexOf("PERSONAL")).toBeGreaterThan(narrow.indexOf("Google Vertex AI"));
});

test("usage reads each owning profile without global or opposite-profile fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
  const save = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value));
  const copilot = (refresh: string) => ({ type: "oauth", refresh });
  try {
    mkdirSync(join(dir, "auth-profiles"));
    save("auth-profiles.json", { activeProfile: "work" });
    save("auth.json", { "github-copilot": copilot("global") });
    save("auth-profiles/work.json", { "github-copilot": copilot("work") });
    save("auth-profiles/personal.json", { "github-copilot": copilot("wrong") });
    expect((await _test.readCopilotCredentials(dir))?.refreshToken).toBe("work");
    save("auth-profiles/work.json", {});
    expect(await _test.readCopilotCredentials(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const directGrant = {
  type: "oauth",
  access: "direct-token",
  refresh: "direct-refresh",
  expires: 4_000_000_000_000,
  clientId: "issued-client",
  scopes: ["openid", "chatgpt.tokens.use.direct"],
};

test("direct ChatGPT grant status distinguishes subscription, invalid and API-key credentials", () => {
  expect(_test.chatgptUsageFrom({ openai: directGrant })).toMatchObject({
    status: "ok",
    data: { usageUrl: "https://chatgpt.com/settings/usage", local: emptyLocalUsage() },
  });
  for (const openai of [
    { ...directGrant, clientId: undefined },
    { ...directGrant, scopes: [] },
    { ...directGrant, access: "" },
  ])
    expect(_test.chatgptUsageFrom({ openai })).toEqual({
      status: "error",
      message: expect.stringContaining("Invalid saved"),
    });
  for (const auth of [null, {}, { openai: { type: "api_key", key: "api-key" } }])
    expect(_test.chatgptUsageFrom(auth)).toBeNull();
  const both = { ...snapshot, chatgpt: _test.chatgptUsageFrom({ openai: directGrant }) };
  expect(profileSnapshotLines(both, theme, "work").join("\n")).not.toContain("settings/usage");
  const personal = profileSnapshotLines(both, theme, "personal").join("\n");
  expect(personal).toContain("ChatGPT subscription (openai)");
  expect(personal).toContain("https://chatgpt.com/settings/usage");
});

test("local ChatGPT activity records request and token totals in 5h and 7d windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-local-usage-"));
  const now = Date.UTC(2026, 0, 1);
  const usage = (input: number, output: number, totalTokens: number, cost: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  try {
    appendLocalUsage(dir, usage(100, 20, 120, 0.5), now - 60 * 60 * 1000);
    appendLocalUsage(dir, usage(200, 40, 240, 1), now - 6 * 60 * 60 * 1000);
    appendLocalUsage(dir, usage(300, 60, 360, 2), now - 8 * 24 * 60 * 60 * 1000);
    writeFileSync(localUsagePath(dir), 'not json\n{"at":"bad"}\n', { flag: "a" });

    const summary = readLocalUsage(dir, now);
    expect(summary.last5h).toMatchObject({ requests: 1, totalTokens: 120, cost: 0.5 });
    expect(summary.last7d).toMatchObject({ requests: 2, totalTokens: 360, cost: 1.5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChatGPT usage renders local activity without claiming plan quota", () => {
  const local = {
    last5h: {
      requests: 2,
      input: 10_000,
      output: 2_345,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12_345,
      cost: 0.42,
    },
    last7d: {
      requests: 5,
      input: 20_000,
      output: 4_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 24_000,
      cost: 0.84,
    },
  };
  const withLocal = applyLocalChatGPTUsage(
    { ...snapshot, chatgpt: _test.chatgptUsageFrom({ openai: directGrant }) },
    local,
  );
  const personal = profileSnapshotLines(withLocal, theme, "personal").join("\n");
  expect(personal).toContain("local Pi activity (not plan quota)");
  expect(personal).toContain("2 requests");
  expect(personal).toContain("12k tokens");
  expect(personal).toContain("$0.4200 est.");
  expect(personal).toContain("https://chatgpt.com/settings/usage");
});
