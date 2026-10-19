import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scratchExtension, { ensureScratchDir } from "../../extensions/scratch.js";

const SESSION_ID = "01a0c9b6-d23f-729e-8572-3c5794e30145";

function withRoot(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scratch dir is named from the random tail of the session id and reused", () => {
  withRoot((root) => {
    const dir = ensureScratchDir(SESSION_ID, root);
    assert.equal(dir, join(root, "pi", "94e30145"));
    assert.equal(statSync(join(root, "pi")).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(ensureScratchDir(SESSION_ID, root), dir);
  });
});

test("scratch dir falls back to a fresh name when the pi directory is not ours", () => {
  withRoot((root) => {
    const target = join(root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(root, "pi"));
    const dir = ensureScratchDir(SESSION_ID, root);
    assert.match(dir, new RegExp(`^${root}/pi-`));
    assert.ok(statSync(dir).isDirectory());
  });
});

test("scratch section is added to the system prompt after session start", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { on: (name: string, handler: never) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  scratchExtension(pi);

  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  handlers.get("before_agent_start")!(event, {});
  assert.equal(event.systemPromptOptions.sections.scratch, undefined);

  handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => SESSION_ID } });
  handlers.get("before_agent_start")!(event, {});
  // agent/tests/setup.ts points PI_SCRATCH_ROOT at a throwaway directory.
  const dir = join(process.env.PI_SCRATCH_ROOT!, "pi", "94e30145");
  assert.match(
    event.systemPromptOptions.sections.scratch,
    new RegExp(`scratch directory for this session is ${dir}\\.`),
  );
  assert.ok(statSync(dir).isDirectory());
});
