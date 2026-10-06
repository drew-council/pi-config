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
  expect(work).toContain("Google Vertex AI");
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
  expect(narrow.indexOf("PERSONAL")).toBeGreaterThan(narrow.indexOf("Google Vertex AI"));
});

test("usage reads each owning profile without global or opposite-profile fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
  const save = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value));
  const codex = (access: string) => ({ type: "oauth", access });
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

const directGrant = {
  type: "oauth",
  access: "direct-token",
  refresh: "direct-refresh",
  expires: 4_000_000_000_000,
  clientId: "issued-client",
  scopes: ["openid", "chatgpt.tokens.use.direct"],
};
const legacyGrant = { type: "oauth", access: "legacy-token", expires: 4_000_000_000_000, accountId: "legacy-account" };

test("direct ChatGPT grant status distinguishes subscription, invalid and API-key credentials", () => {
  expect(_test.chatgptUsageFrom({ openai: directGrant })).toEqual({
    status: "error",
    message: expect.stringContaining("Usage unsupported"),
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
  expect(profileSnapshotLines(both, theme, "work").join("\n")).not.toContain("direct ChatGPT");
  const personal = profileSnapshotLines(both, theme, "personal").join("\n");
  expect(personal).toContain("legacy usage");
  expect(personal).toContain("does not measure this grant");
});

test("wham only receives legacy credentials, including when both providers are saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-chatgpt-usage-"));
  const originalFetch = globalThis.fetch;
  const requests: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 60 } },
    });
  }) as typeof fetch;
  try {
    mkdirSync(join(dir, "auth-profiles"));
    // Wrong profile/global credentials must not be consulted either.
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": legacyGrant }));
    writeFileSync(join(dir, "auth-profiles/work.json"), JSON.stringify({ "openai-codex": legacyGrant }));
    for (const auth of [
      {},
      { openai: directGrant },
      { openai: { type: "api_key", key: "key" } },
      { "openai-codex": { type: "api_key", access: "invalid" } },
    ]) {
      writeFileSync(join(dir, "auth-profiles/personal.json"), JSON.stringify(auth));
      expect((await _test.fetchCodex(undefined, dir)).status).toBe("error");
      expect(requests).toHaveLength(0);
    }
    for (const auth of [{ "openai-codex": legacyGrant }, { openai: directGrant, "openai-codex": legacyGrant }]) {
      writeFileSync(join(dir, "auth-profiles/personal.json"), JSON.stringify(auth));
      const result = await _test.fetchCodex(undefined, dir);
      expect(result.status).toBe("ok");
      if (result.status === "ok")
        expect(result.data.windows).toEqual([{ label: "5h", usedPercent: 25, resetAfterSeconds: 60 }]);
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(request.headers.get("authorization")).toBe("Bearer legacy-token");
      expect(request.headers.get("ChatGPT-Account-Id")).toBe("legacy-account");
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
