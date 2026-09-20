import assert from "node:assert/strict";
import test from "node:test";
import type { TuicrComment, TuicrReview } from "../../extensions/tuicr-review/parser.js";
import { formatPrompt } from "../../extensions/tuicr-review/prompt.js";
import { remainingComments } from "../../extensions/tuicr-review/state.js";

function comment(id: string, body = "body"): TuicrComment {
  return { id, ordinal: Number(id.split("-")[1]), location: `src/${id}.ts:1`, path: `src/${id}.ts`, body };
}

function review(...comments: TuicrComment[]): TuicrReview {
  return { comments };
}

test("remaining comments preserves review order and filters addressed ids", () => {
  const reviewComments = [comment("comment-1"), comment("comment-2"), comment("comment-3")];
  assert.deepEqual(
    remainingComments(review(...reviewComments), ["comment-2"]).map((entry) => entry.id),
    ["comment-1", "comment-3"],
  );
  assert.deepEqual(remainingComments(review(...reviewComments), []).length, 3);
  assert.deepEqual(remainingComments(review(...reviewComments), ["comment-1", "comment-2", "comment-3"]), []);
});

test("remaining comments tolerates persisted ids that no longer exist", () => {
  assert.deepEqual(remainingComments(review(comment("comment-1")), ["comment-1", "comment-99"]), []);
});

test("formatPrompt renders every selected comment without appending extra information", () => {
  const prompt = formatPrompt(
    [
      { ...comment("comment-1"), type: "ISSUE", context: "(commit abc)", body: "First line\nsecond line" },
      { ...comment("comment-2"), body: "Only a body" },
    ],
    "   ",
  );

  assert.match(prompt, /Address the following selected code review comments/);
  assert.match(prompt, /1\. \*\*\[ISSUE\]\*\* `src\/comment-1\.ts:1` \(commit abc\) - First line\n {3}second line/);
  assert.match(prompt, /2\. `src\/comment-2\.ts:1` - Only a body/);
  assert.doesNotMatch(prompt, /Additional information from the user/);
});

test("formatPrompt appends trimmed additional information when provided", () => {
  const prompt = formatPrompt([comment("comment-1")], "  Keep the API stable.  ");

  assert.match(prompt, /## Additional information from the user\n\nKeep the API stable\.$/);
});
