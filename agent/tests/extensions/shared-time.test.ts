import assert from "node:assert/strict";
import test from "node:test";
import { formatClockTime, formatDuration } from "../../extensions/shared/time.js";

test("formatDuration formats seconds, minutes, and hours", () => {
  assert.equal(formatDuration(-500), "0s");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(499), "0s");
  assert.equal(formatDuration(500), "1s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration((42 * 60 + 13) * 1_000), "42m 13s");
  assert.equal(formatDuration(2 * 60 * 1_000), "2m 0s");
  assert.equal(formatDuration((3_600 + 14 * 60 + 17) * 1_000), "1h 14m 17s");
});

test("formatClockTime formats Date and epoch timestamps in 12-hour time with ASCII spaces", () => {
  const morning = new Date(2026, 3, 19, 11, 14, 0);
  const afternoon = new Date(2026, 3, 19, 18, 5, 0);
  assert.equal(formatClockTime(morning), "11:14 AM");
  assert.equal(formatClockTime(morning.getTime()), "11:14 AM");
  assert.equal(formatClockTime(afternoon), "6:05 PM");
});
