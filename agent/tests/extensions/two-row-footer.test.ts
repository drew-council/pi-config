import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import twoRowFooter from "../../extensions/two-row-footer.js";

function usage(input = 10, output = 2, cacheRead = 30, cacheWrite = 10, cost = 0.125): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function entry(id: string, type = "message", value = usage(), role = "assistant"): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    type,
    ...(type === "message" ? { message: { role, usage: value } } : { usage: value }),
  } as SessionEntry;
}

function harness(initial: SessionEntry[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const state = {
    entries: initial,
    leaf: initial.at(-1),
    header: { id: "session-1" },
    scans: 0,
    color: "",
    context: { contextWindow: 100000, percent: 20 as number | null },
  };
  let footer: { render(width: number): string[]; invalidate(): void; dispose(): void };
  const ctx = {
    mode: "tui",
    model: { id: "auto", provider: "router", reasoning: true, contextWindow: 200000 },
    thinkingLevel: "medium",
    getContextUsage: () => state.context,
    sessionManager: {
      getHeader: () => state.header,
      getLeafEntry: () => state.leaf,
      getEntries: () => {
        state.scans++;
        return state.entries.slice();
      },
      getCwd: () => "/project",
      getSessionName: () => "",
    },
    ui: {
      setFooter: (factory) => {
        footer = factory(
          { requestRender() {} },
          { fg: (_color, text) => state.color + text },
          {
            onBranchChange: () => () => {},
            getGitBranch: () => "main",
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 2,
          },
        );
      },
    },
  } as unknown as ExtensionContext;
  twoRowFooter({ on: (name, handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({}, ctx);
  emit("session_start");
  return {
    state,
    ctx,
    emit,
    render: () => footer.render(240),
    invalidate: () => footer.invalidate(),
    append: (next: SessionEntry) => {
      state.entries.push(next);
      state.leaf = next;
    },
  };
}

test("two-row-footer caches raw all-session usage across repeated renders and theme invalidation", () => {
  const h = harness([
    entry("a"),
    entry("t", "message", usage(), "toolResult"),
    entry("c", "compaction"),
    entry("b", "branch_summary"),
    entry("u", "usage"),
  ]);
  assert.ok(h.render()[0].includes("↑50 ↓10 R150 W50 CH60.0% $0.625 20.0%/100k (auto)"));
  for (let i = 0; i < 1000; i++) h.render();
  assert.equal(h.state.scans, 1);
  h.state.color = "theme:";
  h.invalidate();
  assert.ok(h.render()[0].includes("theme:↑50"));
  assert.equal(h.state.scans, 1);
});

test("two-row-footer refreshes same-ID replacements and finalized message changes", () => {
  const h = harness([entry("a")]);
  h.render();
  const replacement = entry("a", "message", usage(1, 1, 0, 0, 0.5));
  h.state.entries = [replacement];
  h.state.leaf = replacement;
  assert.ok(h.render()[0].includes("↑1 ↓1 $0.500"));
  // A finalized-message event must invalidate even if an existing object was reused.
  if (replacement.type === "message" && replacement.message.role === "assistant") {
    replacement.message.usage = usage(2, 2, 0, 0, 0.25);
  }
  h.emit("message_end");
  assert.ok(h.render()[0].includes("↑2 ↓2 $0.250"));
  assert.equal(h.state.scans, 3);
});

test("two-row-footer handles appends, branch/context edits and session reloads without losing raw costs", () => {
  const first = entry("a");
  const h = harness([first]);
  h.render();
  h.append(entry("new", "message", usage(20, 3, 20, 0, 0.25)));
  assert.ok(h.render()[0].includes("↑30 ↓5 R50 W10 CH50.0% $0.375"));
  h.state.leaf = first;
  assert.ok(h.render()[0].includes("↑30 ↓5 R50 W10 CH50.0% $0.375"));
  h.append({ id: "edit", parentId: "a", timestamp: "", type: "context_edit", targetId: "a", replacement: null });
  h.state.context.percent = null;
  assert.ok(h.render()[0].includes("↑30 ↓5 R50 W10 CH50.0% $0.375 ?/100k (auto)"));
  h.state.entries = [];
  h.state.leaf = undefined;
  h.state.header = { id: "session-2" };
  assert.ok(!h.render()[0].includes("↑"));
  h.state.entries = [entry("zero", "message", usage(0, 1, 0, 0, 0))];
  h.state.leaf = h.state.entries[0];
  h.state.header = { id: "session-2" }; // Reload with the same session ID.
  assert.ok(!h.render()[0].includes("CH"));
  h.emit("session_start");
  assert.ok(h.render()[0].includes("↓1"));
  assert.equal(h.state.scans, 7);
});
