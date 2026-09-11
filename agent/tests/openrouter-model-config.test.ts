import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ModelConfig } from "../../bun/typecheck/node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";

test("OpenRouter model override preserves the reviewed privacy, region, and price boundaries", async () => {
  const config = await ModelConfig.load(join(import.meta.dirname, "..", "models.json"));
  assert.equal(config.getError(), undefined);

  const provider = config.getProvider("openrouter");
  assert.ok(provider);
  assert.equal(provider.baseUrl, undefined);
  assert.equal(provider.api, undefined);
  assert.equal(provider.models, undefined);
  // Authentication belongs to auth-profiles/personal.json, not a global models.json fallback.
  assert.equal(provider.apiKey, undefined);

  const model = provider.modelOverrides?.["z-ai/glm-5.3-flash"];
  assert.ok(model);
  assert.deepEqual(model.cost, {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  });

  const compat = model.compat;
  assert.ok(compat && "openRouterRouting" in compat);
  assert.equal(compat.maxTokensField, "max_tokens");
  const routing = compat.openRouterRouting;
  assert.ok(routing);
  assert.equal(routing.data_collection, "deny");
  assert.equal(routing.zdr, true);
  assert.equal(routing.allow_fallbacks, true);
  assert.equal(routing.require_parameters, true);
  assert.equal(routing.sort, "throughput");
  assert.equal(routing.order, undefined);
  assert.ok(routing.only && routing.only.length > 0);
  assert.equal(new Set(routing.only).size, routing.only.length);
  assert.deepEqual(routing.max_price, { prompt: 0.15, completion: 0.5 });
});
