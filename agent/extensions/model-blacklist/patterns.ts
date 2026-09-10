/** Models matching any of these expressions are omitted from `/model`. */
export const MODEL_BLACKLIST = [
  // Gemini: keep only 3.8+ (blacklists 1.x/2.x, 3.0 preview era, 3.0–3.7 point
  // releases, and rolling -latest aliases). Future 3.9/4.x+ stay visible by default.
  /gemini-(?!(?:3\.[89]|[4-9]\.\d))/i,
  /^gemma-/i,
  /^deep-research-/i,
  /^grok-(?:[0-3](?:\.\d+)?|4(?:\.[0-4])?(?:$|-))/i,
  /^gpt-(?:[0-4](?:\.\d+)?|5(?:\.[0-5])?(?:$|-))/i,
  // Claude: keep only 5+ major versions (drops claude-opus-4-*, claude-sonnet-4-*,
  // claude-haiku-4-*, and legacy claude-3-* ids from any provider).
  /^claude-(?:(?:opus|sonnet|haiku|fable)-[0-4]|[0-4])(?:[-.]\d+)*(?:$|-)/i,
  /^openrouter\/(?!z-ai\/glm-5\.3-flash$)/i,
  // GitHub Copilot: whitelist GPT-5.6 and newer (luna/sol/terra, 6.x/astra).
  // The work profile's Copilot subscription is restricted to those models; GLM
  // models are not offered on Copilot (GLM-5.3 Flash stays on OpenRouter).
  /^github-copilot\/(?!gpt-(?:5\.[6-9]|[6-9]))/i,
] satisfies readonly RegExp[];
