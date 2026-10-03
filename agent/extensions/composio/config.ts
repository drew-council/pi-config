import { readJson } from "../shared/accounts.js";

export interface ComposioPolicy {
  toolkits: string[];
  tools: Record<string, { enable?: string[]; disable?: string[] }>;
}

export function readComposioKey(path: string): string {
  const secrets = readJson(path);
  const key = (secrets.composio as { apiKey?: unknown } | undefined)?.apiKey;
  if (typeof key !== "string" || !key.trim() || /op:\/\/|\{\{/.test(key)) {
    throw new Error("Missing composio.apiKey in generated personal secrets. Regenerate secrets/personal.json.");
  }
  if (!key.trim().startsWith("ck_")) {
    throw new Error("This connector needs a Composio For You consumer key (ck_), from For You → AI Clients.");
  }
  return key.trim();
}

export function readComposioPolicy(path: string): ComposioPolicy {
  const value = readJson(path);
  const validList = (list: unknown, pattern: RegExp): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === "string" && pattern.test(item));
  if (!validList(value.toolkits, /^[a-z][a-z0-9_]*$/)) {
    throw new Error("composio.json must contain a toolkits array of lowercase toolkit slugs.");
  }
  const tools = value.tools ?? {};
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new Error("composio.json tools must be an object keyed by toolkit slug.");
  }
  for (const [toolkit, rule] of Object.entries(tools)) {
    if (!value.toolkits.includes(toolkit) || !rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`Invalid Composio tool rule for ${toolkit}.`);
    }
    for (const [mode, list] of Object.entries(rule)) {
      if (
        !["enable", "disable"].includes(mode) ||
        !validList(list, /^[A-Z][A-Z0-9_]*$/) ||
        !list.every((slug) => slug.startsWith(`${toolkit.toUpperCase()}_`))
      ) {
        throw new Error(
          `Invalid Composio ${toolkit} tool rule; use enable/disable arrays of that toolkit's tool slugs.`,
        );
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (!["toolkits", "tools"].includes(key)) throw new Error(`Unknown composio.json setting: ${key}.`);
  }
  return { toolkits: [...new Set(value.toolkits)], tools: tools as ComposioPolicy["tools"] };
}

export function isComposioToolAllowed(policy: ComposioPolicy, slug: string): boolean {
  const toolkit = policy.toolkits.find((name) => slug.startsWith(`${name.toUpperCase()}_`));
  if (!toolkit) return false;
  const rule = policy.tools[toolkit];
  return (!rule?.enable || rule.enable.includes(slug)) && !rule?.disable?.includes(slug);
}

export function assertComposioToolAllowed(policy: ComposioPolicy, slug: string): void {
  if (!isComposioToolAllowed(policy, slug)) throw new Error(`Composio policy does not allow ${slug}.`);
}
