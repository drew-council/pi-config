import assert from "node:assert/strict";
import test from "node:test";
import { clampPercent, formatMoney, humanizeSeconds } from "../extensions/usage/format.js";
import { applyOpenRouterCredits, parseOpenRouterKeyUsage } from "../extensions/usage/openrouter.js";

test("OpenRouter key usage parses the auth/key payload", () => {
  const data = parseOpenRouterKeyUsage({
    data: {
      label: "sk-or-v1-88a...b0d",
      limit: 50,
      limit_reset: "monthly",
      limit_remaining: 49.999336775,
      usage: 0.000663225,
      usage_monthly: 0.000663225,
    },
  });
  assert.ok(data);
  assert.equal(data.limit, 50);
  assert.equal(data.limitReset, "monthly");
  assert.equal(data.usage, 0.000663225);
  assert.equal(data.totalCredits, null);
});

test("OpenRouter credits payload merges into the key usage", () => {
  const base = parseOpenRouterKeyUsage({ data: { usage: 1.25, limit: 50 } });
  assert.ok(base);
  const merged = applyOpenRouterCredits(base, { data: { total_credits: 50, total_usage: 1.25 } });
  assert.equal(merged.totalCredits, 50);
  assert.equal(merged.totalUsage, 1.25);
  assert.equal(applyOpenRouterCredits(base, null).totalCredits, null);
});

test("Formatting helpers produce human-readable output", () => {
  assert.equal(humanizeSeconds(45), "45s");
  assert.equal(humanizeSeconds(3600), "1h");
  assert.equal(humanizeSeconds(3900), "1h 5m");
  assert.equal(humanizeSeconds(192012), "2d 5h");
  assert.equal(humanizeSeconds(0), "now");
  assert.equal(formatMoney(50), "$50.00");
  assert.equal(formatMoney(0.000663225), "$0.0007");
  assert.equal(formatMoney(null), "?");
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent("42.5"), 42.5);
  assert.equal(clampPercent("nan"), 0);
});
