import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import browserLogExtension, { _test } from "../../extensions/browser-log.js";

const {
  normalizeBrowserLogOptions,
  parseBrowserLogArgs,
  isInspectablePage,
  scoreTarget,
  formatConsoleArgs,
  normalizeConsoleEvent,
  normalizeExceptionEvent,
  normalizeLogEntry,
  summarizeEntries,
} = _test;

test("browser-log options normalize command arguments and reject invalid durations", () => {
  assert.deepEqual(parseBrowserLogArgs("--port=9333 --cdp-url=http://localhost:9444/// --duration-ms=45000"), {
    cdpUrl: "http://localhost:9444",
    durationMs: 30_000,
  });
  assert.deepEqual(parseBrowserLogArgs("250 'https://example.test:9222/'"), {
    cdpUrl: "https://example.test:9222",
    durationMs: 250,
  });
  assert.deepEqual(normalizeBrowserLogOptions({ cdpUrl: "http://localhost:9222///", durationMs: -1 }), {
    cdpUrl: "http://localhost:9222",
    durationMs: 1_500,
  });
  assert.equal(
    normalizeBrowserLogOptions({ cdpUrl: "http://localhost:9222", durationMs: Number.NaN }).durationMs,
    1_500,
  );
});

test("target filtering and scoring prefer a focused visible web page", () => {
  const focusedPage = {
    id: "focused",
    type: "page",
    title: "Application",
    url: "https://example.test",
    webSocketDebuggerUrl: "ws://localhost/focused",
  };

  assert.equal(isInspectablePage(focusedPage), true);
  assert.equal(
    isInspectablePage({ ...focusedPage, id: "devtools", url: "devtools://devtools/bundled/inspector.html" }),
    false,
  );
  assert.equal(isInspectablePage({ ...focusedPage, id: "worker", type: "service_worker" }), false);
  assert.equal(isInspectablePage({ ...focusedPage, id: "detached", webSocketDebuggerUrl: undefined }), false);

  assert.deepEqual(scoreTarget(focusedPage, { hasFocus: true, visibilityState: "visible" }), {
    score: 161,
    reason: "document.hasFocus() is true; document.visibilityState is visible; HTTP(S) page; has title",
  });
  assert.equal(
    scoreTarget({ ...focusedPage, title: "", url: "about:blank" }, { hasFocus: false, visibilityState: "hidden" })
      .score,
    0,
  );
});

test("console formatting follows CDP format specifiers and preserves remaining values", () => {
  const message = formatConsoleArgs([
    { type: "string", value: "loaded %s in %dms %% %cstyled" },
    { type: "string", value: "app" },
    { type: "number", value: 12 },
    { type: "string", value: "color: green" },
    { type: "object", description: "Object {ready: true}" },
  ]);

  assert.equal(message, "loaded app in 12ms % styled Object {ready: true}");
  assert.equal(
    formatConsoleArgs([
      { type: "number", unserializableValue: "NaN" },
      { type: "object", value: { ok: true } },
    ]),
    'NaN {"ok":true}',
  );
});

test("normalized CDP events produce stable messages and aggregate summaries", () => {
  const entries = [
    normalizeConsoleEvent(0, {
      type: "warning",
      timestamp: 3_000,
      args: [
        { type: "string", value: "slow %dms" },
        { type: "number", value: 80 },
      ],
    }),
    normalizeExceptionEvent(1, {
      timestamp: 1_000,
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: failed" } },
    }),
    normalizeLogEntry(2, { entry: { level: "warning", text: "deprecated", timestamp: 2_000 } }),
  ];

  assert.equal(entries[0]?.message, "slow 80ms");
  assert.equal(entries[1]?.message, "TypeError: failed");
  assert.equal(entries[2]?.message, "deprecated");
  assert.deepEqual(summarizeEntries(entries), {
    totalEntries: 3,
    byKind: { console: 1, exception: 1, "browser-log": 1 },
    byLevel: { warning: 2, error: 1 },
    firstTimestampIso: "1970-01-01T00:00:01.000Z",
    lastTimestampIso: "1970-01-01T00:00:03.000Z",
  });
});

function captureFixture(entries = [normalizeConsoleEvent(0, { type: "warning", timestamp: 1_000, args: [] })]) {
  return {
    filePath: "/saved/browser-log.json",
    report: {
      schemaVersion: 1 as const,
      capturedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      cdpUrl: "http://localhost:9222",
      target: {
        id: "active",
        type: "page",
        title: "Application",
        url: "https://example.test",
        webSocketDebuggerUrl: "ws://localhost/active",
        score: 161,
        selectionReason: "focused visible page",
        pageInfo: { hasFocus: true },
      },
      candidateTargets: [],
      summary: summarizeEntries(entries),
      entries,
    },
  };
}

test("capture_browser_log returns schema-valid data while preserving direct text and renderer details", async () => {
  const fixture = captureFixture();
  const controller = new AbortController();
  const tool = _test.createBrowserLogTool(async (options, signal) => {
    assert.deepEqual(options, { cdpUrl: "http://localhost:9222", durationMs: 0 });
    assert.equal(signal, controller.signal);
    return fixture;
  });
  const result = await tool.execute(
    "capture",
    { cdpUrl: "http://localhost:9222///", durationMs: 0 },
    controller.signal,
  );
  assert.deepEqual(result.structuredContent, {
    filePath: fixture.filePath,
    summary: fixture.report.summary,
    target: { id: "active", title: "Application", url: "https://example.test" },
  });
  assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
  assert.deepEqual(result.details, {
    filePath: fixture.filePath,
    summary: fixture.report.summary,
    target: fixture.report.target,
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: [
        "Browser logs captured from the active Chromium tab.",
        "Path: /saved/browser-log.json",
        "Target: Application — https://example.test",
        "Entries: 1 (warning: 1)",
        "The file is structured JSON with metadata, target selection details, and normalized log entries.",
      ].join("\n"),
    },
  ]);
});

test("capture_browser_log schema covers empty and untimestamped captures and rejects malformed data", async () => {
  for (const entries of [[], [normalizeLogEntry(0, { entry: { text: "no timestamp" } })]]) {
    const fixture = captureFixture(entries);
    fixture.report.target.title = "";
    const tool = _test.createBrowserLogTool(async () => fixture);
    const result = await tool.execute("capture", {});
    const validator = Compile(tool.outputSchema);
    assert.equal(validator.Check(result.structuredContent), true);
    assert.equal(validator.Check(JSON.parse(JSON.stringify(result.structuredContent))), true);
    assert.equal(Object.hasOwn(result.structuredContent.summary, "firstTimestampIso"), false);
    assert.equal(Object.hasOwn(result.structuredContent.summary, "lastTimestampIso"), false);
    assert.match(result.content[0].text, /Target: \(untitled\)/);
    assert.equal(validator.Check({ ...result.structuredContent, filePath: 42 }), false);
    assert.equal(
      validator.Check({ summary: result.structuredContent.summary, target: result.structuredContent.target }),
      false,
    );
    assert.equal(
      validator.Check({ ...result.structuredContent, summary: { totalEntries: -1, byKind: {}, byLevel: {} } }),
      false,
    );
    assert.equal(
      validator.Check({ ...result.structuredContent, target: { id: "active", title: "Application" } }),
      false,
    );
  }
});

test("capture_browser_log still throws capture failures and forwards cancellation without returning success data", async () => {
  for (const message of ["No inspectable Chromium page targets found", "Operation aborted", "Unable to save report"]) {
    const error = new Error(message);
    const controller = new AbortController();
    controller.abort();
    const tool = _test.createBrowserLogTool(async (_options, signal) => {
      assert.equal(signal, controller.signal);
      assert.equal(signal?.aborted, true);
      throw error;
    });
    await assert.rejects(tool.execute("capture", {}, controller.signal), (actual) => actual === error);
  }
});

test("browser-log registers the structured tool without changing its default direct exposure", () => {
  const tools: ReturnType<typeof _test.createBrowserLogTool>[] = [];
  const commands: string[] = [];
  browserLogExtension({
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name) => commands.push(name),
  } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["browser-log"]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "capture_browser_log");
  assert.deepEqual(tools[0]?.outputSchema, _test.createBrowserLogTool().outputSchema);
  assert.equal(Object.hasOwn(tools[0], "exposure"), false);
});
