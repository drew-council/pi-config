import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReviewPrompt,
  collectEvidence,
  parseVerdict,
  REVIEWERS,
  reviewerFor,
} from "../../extensions/security/review.js";
import { readActiveProfile } from "../../extensions/shared/accounts.js";

const message = (message: Record<string, unknown>) => ({ type: "message", message });

test("collectEvidence flattens the transcript and drops thinking", () => {
  const entries = [
    { type: "compaction", summary: "Earlier we set up a scratch dir." },
    message({ role: "user", content: "please clean up /tmp/scratch" }),
    message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "Removing it now." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rm -rf /tmp/scratch", timeout: 5 } },
      ],
    }),
    message({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c1",
      isError: false,
      content: [{ type: "text", text: "" }],
    }),
    message({
      role: "user",
      content: [
        { type: "text", text: "thanks" },
        { type: "image", data: "..." },
      ],
    }),
    { type: "model_change", provider: "google", modelId: "x" },
  ];

  const lines = collectEvidence(entries);
  assert.deepEqual(lines, [
    "COMPACTION SUMMARY: Earlier we set up a scratch dir.",
    "USER: please clean up /tmp/scratch",
    "ASSISTANT: Removing it now.",
    'TOOL bash {"command":"rm -rf /tmp/scratch"}',
    "RESULT bash -> ok",
    "USER: thanks",
  ]);
  assert.ok(!lines.join("\n").includes("secret reasoning"));
});

test("collectEvidence keeps the most recent lines when over budget", () => {
  const entries = Array.from({ length: 5 }, (_, i) =>
    message({ role: "user", content: `message ${i} ${"x".repeat(40)}` }),
  );
  // Each line is 56 chars plus a newline; 120 fits exactly two of them.
  const lines = collectEvidence(entries, 120);
  assert.equal(lines[0], "[earlier conversation omitted]");
  assert.equal(lines.at(-1), `USER: message 4 ${"x".repeat(40)}`);
  assert.equal(lines.length, 3);
});

test("collectEvidence clips long text and tool output", () => {
  const long = "a".repeat(5000);
  const lines = collectEvidence([
    message({ role: "user", content: long }),
    message({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c1",
      isError: true,
      content: [{ type: "text", text: long }],
    }),
  ]);
  assert.ok(lines[0].length < 2100);
  assert.match(lines[0], /^USER: a+ \.\.\. a+$/);
  assert.match(lines[1], /^RESULT bash -> error: a+ \.\.\. a+$/);
  assert.ok(lines[1].length < 450);
});

test("buildReviewPrompt includes transcript, gate, cwd, and command", () => {
  const prompt = buildReviewPrompt(["USER: hi"], { command: "rm -rf /tmp/x", cwd: "/work", gate: "recursive delete" });
  assert.match(prompt, /<TRANSCRIPT>\nUSER: hi\n<\/TRANSCRIPT>/);
  assert.match(
    prompt,
    /<PROPOSED_COMMAND gate="recursive delete" cwd="\/work">\nrm -rf \/tmp\/x\n<\/PROPOSED_COMMAND>/,
  );
  assert.match(buildReviewPrompt([], { command: "x", cwd: "/", gate: "g" }), /<empty transcript>/);
});

test("parseVerdict accepts plain and fenced JSON and rejects other decisions", () => {
  assert.deepEqual(parseVerdict('{"decision":"approve","reason":"under /tmp"}'), {
    decision: "approve",
    reason: "under /tmp",
  });
  assert.deepEqual(parseVerdict('```json\n{"decision":"ask_user","reason":" unclear "}\n```'), {
    decision: "ask_user",
    reason: "unclear",
  });
  assert.deepEqual(parseVerdict('Sure! {"decision":"approve"} done'), {
    decision: "approve",
    reason: "no reason given",
  });
  assert.throws(() => parseVerdict('{"decision":"revise","reason":"x"}'), /invalid decision/);
  assert.throws(() => parseVerdict("no json here"), /no JSON object/);
});

test("reviewer choice follows the active profile", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-security-review-"));
  writeFileSync(path.join(agentDir, "auth-profiles.json"), '{"activeProfile":"personal"}\n');

  const previous = process.env.PI_AUTH_PROFILE;
  try {
    process.env.PI_AUTH_PROFILE = "work";
    assert.equal(readActiveProfile(agentDir), "work");
    assert.deepEqual(reviewerFor("work"), { provider: "google", model: "gemini-3.8-flash", thinking: "medium" });

    delete process.env.PI_AUTH_PROFILE;
    assert.equal(readActiveProfile(agentDir), "personal");
    assert.equal(reviewerFor("personal"), REVIEWERS.personal);
    assert.equal(REVIEWERS.personal.provider, "openrouter");
  } finally {
    if (previous === undefined) delete process.env.PI_AUTH_PROFILE;
    else process.env.PI_AUTH_PROFILE = previous;
  }
});
