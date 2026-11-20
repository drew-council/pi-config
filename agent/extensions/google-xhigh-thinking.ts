import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Sends Gemini's `XHIGH` thinking level, which pi's Google providers cannot express yet.
 *
 * Models listed here MUST map `xhigh` to `high` in `models.json`, so pi accepts the level and
 * builds a `HIGH` request. This rewrites that request to `XHIGH` when the session level is xhigh.
 */
export const XHIGH_MODELS: ReadonlySet<string> = new Set(["google-vertex/gemini-4-neon"]);

interface GooglePayload {
  config?: { thinkingConfig?: { thinkingLevel?: unknown } };
}

export function withXHighThinking(payload: unknown): unknown {
  const config = (payload as GooglePayload | null)?.config;
  if (config?.thinkingConfig?.thinkingLevel !== "HIGH") return undefined;
  return {
    ...(payload as object),
    config: { ...config, thinkingConfig: { ...config.thinkingConfig, thinkingLevel: "XHIGH" } },
  };
}

export default function googleXHighThinkingExtension(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || !XHIGH_MODELS.has(`${model.provider}/${model.id}`)) return undefined;
    if (pi.getThinkingLevel() !== "xhigh") return undefined;
    return withXHighThinking(event.payload);
  });
}
