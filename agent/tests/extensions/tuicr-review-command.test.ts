import assert from "node:assert/strict";
import test from "node:test";
import { planTuicrCommand } from "../../extensions/tuicr-review/command.js";

test("bare /tuicr resumes when comments remain in the queue", () => {
  assert.deepEqual(planTuicrCommand("", 3), { kind: "resume" });
  assert.deepEqual(planTuicrCommand("   ", 1), { kind: "resume" });
});

test("bare /tuicr parses the clipboard when the queue is empty", () => {
  assert.deepEqual(planTuicrCommand("", 0), { kind: "parse", input: { type: "clipboard" } });
});

test("parse reads a file when an argument is given and the clipboard otherwise", () => {
  assert.deepEqual(planTuicrCommand("parse review.md", 0), {
    kind: "parse",
    input: { type: "file", argument: "review.md" },
  });
  assert.deepEqual(planTuicrCommand("parse", 0), { kind: "parse", input: { type: "clipboard" } });
  assert.deepEqual(planTuicrCommand("parse   ", 5), { kind: "parse", input: { type: "clipboard" } });
});

test("explicit resume ignores the queue and rejects arguments", () => {
  assert.deepEqual(planTuicrCommand("resume", 0), { kind: "resume" });
  assert.deepEqual(planTuicrCommand("RESUME", 0), { kind: "resume" });
  assert.deepEqual(planTuicrCommand("resume now", 0), { kind: "usage" });
});

test("clear discards the queue and rejects arguments", () => {
  assert.deepEqual(planTuicrCommand("clear", 4), { kind: "clear" });
  assert.deepEqual(planTuicrCommand(" clear ", 0), { kind: "clear" });
  assert.deepEqual(planTuicrCommand("clear all", 4), { kind: "usage" });
});

test("unknown subcommands fall back to usage", () => {
  assert.deepEqual(planTuicrCommand("nope", 0), { kind: "usage" });
  assert.deepEqual(planTuicrCommand("nope something", 2), { kind: "usage" });
});
