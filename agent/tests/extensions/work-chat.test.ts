import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import workChat from "../../extensions/work-chat.js";

const originalProfile = process.env.PI_AUTH_PROFILE;
const originalPii = process.env.PI_PII_MODE;
const dirs: string[] = [];
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PI_AUTH_PROFILE;
  else process.env.PI_AUTH_PROFILE = originalProfile;
  if (originalPii === undefined) delete process.env.PI_PII_MODE;
  else process.env.PI_PII_MODE = originalPii;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handler = (event?: {
  toolName: string;
  input: object;
  parentToolCallId?: string;
}) => { block: boolean } | undefined;
function setup(secrets: object | null = { googleChat: { clientSecret: "test-secret" } }) {
  const root = mkdtempSync(join(tmpdir(), "work-chat-test-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(join(root, "secrets"));
  if (secrets) writeFileSync(join(root, "secrets", "work.json"), JSON.stringify(secrets));
  const handlers = new Map<string, Handler>();
  const events = new Map<string, () => void>();
  const servers = new Map<string, McpServerConfig>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: { on: (name: string, handler: () => void) => events.set(name, handler) },
    registerMcpServer: (name: string, config: McpServerConfig) => servers.set(name, config),
    unregisterMcpServer: (name: string) => servers.delete(name),
  };
  workChat(pi as unknown as ExtensionAPI, agentDir);
  return { handlers, events, servers };
}
function mode(profile: string, pii?: string) {
  process.env.PI_AUTH_PROFILE = profile;
  if (pii === undefined) delete process.env.PI_PII_MODE;
  else process.env.PI_PII_MODE = pii;
}

test("work Chat registers Google's hosted server with read-only scopes and tools", () => {
  mode("work");
  const h = setup();
  h.handlers.get("session_start")?.();
  const config = h.servers.get("work-chat");
  if (!config || !("url" in config)) throw new Error("expected an HTTP server");
  expect(config.url).toBe("https://chatmcp.googleapis.com/mcp/v1");
  expect(config.oauth?.clientId).toEndWith(".apps.googleusercontent.com");
  expect(config.oauth?.clientSecret).toStartWith("!jq ");
  expect(config.oauth?.clientSecret).not.toContain("test-secret");
  expect(config.oauth?.callbackPort).toBe(8765);
  const scopes = config.oauth?.scope?.split(" ") ?? [];
  expect(scopes).toHaveLength(4);
  for (const scope of scopes) expect(scope).toMatch(/\.(readonly|readstate)$/);
  expect(config.exposure).toBe("hidden");
  expect(Object.keys(config.toolExposure ?? {})).not.toContain("send_message");
});

test("personal mode, PII mode, and a missing or uninjected secret do not register Chat", () => {
  for (const [profile, pii] of [
    ["personal", undefined],
    ["work", "1"],
    ["unknown", undefined],
  ]) {
    mode(profile, pii);
    const h = setup();
    h.handlers.get("session_start")?.();
    expect(h.servers.size).toBe(0);
  }
  mode("work");
  const uninjected = { googleChat: { clientSecret: "{{ op://Employee/item/credential }}" } };
  for (const secrets of [null, {}, uninjected]) {
    const h = setup(secrets);
    h.handlers.get("session_start")?.();
    expect(h.servers.size).toBe(0);
  }
});

test("profile changes unregister the server and calls are guarded", () => {
  mode("work");
  const h = setup();
  h.handlers.get("session_start")?.();
  const call = h.handlers.get("tool_call");
  const event = { toolName: "mcp__work_chat__search_messages", input: {} };
  expect(call?.(event)).toBeUndefined();
  mode("personal");
  h.events.get("auth-profile:changed")?.();
  expect(h.servers.size).toBe(0);
  for (const parentToolCallId of [undefined, "nested"])
    expect(call?.({ ...event, parentToolCallId })?.block).toBe(true);
  mode("work");
  h.events.get("auth-profile:changed")?.();
  expect(h.servers.size).toBe(1);
  h.handlers.get("session_shutdown")?.();
  expect(h.servers.size).toBe(0);
});
