import { readJson } from "../shared/accounts.js";

export interface ComposioPolicy {
  /** Blocked toolkit slugs (`github`) and tool slugs (`GMAIL_DELETE_MESSAGE`); everything else is allowed. */
  disable: string[];
}

const TOOLKIT_SLUG = /^[a-z][a-z0-9_]*$/;
const TOOL_SLUG = /^[A-Z][A-Z0-9_]*$/;
/** Connect's own meta-tools. They run through the dedicated helpers or not at all, never as app actions. */
const META_TOOLS = new Set([
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MANAGE_SKILL",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_SEARCH_SKILLS",
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_SUBMIT_FEEDBACK",
  "COMPOSIO_USE_SKILL",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

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
  for (const key of Object.keys(value)) {
    if (key !== "disable") throw new Error(`Unknown composio.json setting: ${key}. Only a disable list is supported.`);
  }
  const disable = value.disable ?? [];
  if (
    !Array.isArray(disable) ||
    !disable.every((entry) => typeof entry === "string" && (TOOLKIT_SLUG.test(entry) || TOOL_SLUG.test(entry)))
  ) {
    throw new Error("composio.json disable must list toolkit slugs (github) or tool slugs (GMAIL_DELETE_MESSAGE).");
  }
  return { disable: [...new Set(disable as string[])] };
}

export function isComposioToolkitAllowed(policy: ComposioPolicy, toolkit: string): boolean {
  return !policy.disable.includes(toolkit.toLowerCase());
}

export function isComposioToolAllowed(policy: ComposioPolicy, slug: string): boolean {
  if (META_TOOLS.has(slug)) return false;
  return !policy.disable.some(
    (entry) => entry === slug || (TOOLKIT_SLUG.test(entry) && slug.startsWith(`${entry.toUpperCase()}_`)),
  );
}

export function assertComposioToolAllowed(policy: ComposioPolicy, slug: string): void {
  if (!isComposioToolAllowed(policy, slug)) throw new Error(`Composio policy does not allow ${slug}.`);
}
