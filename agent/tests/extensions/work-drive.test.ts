import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import workDrive from "../../extensions/work-drive.js";

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
  input: { user_google_email?: string };
  parentToolCallId?: string;
}) => { block: boolean } | undefined;
function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-drive-test-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "work-drive-client.json"), "{}");
  const handlers = new Map<string, Handler>();
  const events = new Map<string, () => void>();
  const servers = new Map<string, McpServerConfig>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: { on: (name: string, handler: () => void) => events.set(name, handler) },
    registerMcpServer: (name: string, config: McpServerConfig) => servers.set(name, config),
    unregisterMcpServer: (name: string) => servers.delete(name),
  };
  workDrive(pi as unknown as ExtensionAPI, agentDir);
  return { handlers, events, servers };
}
function mode(profile: string, pii?: string) {
  process.env.PI_AUTH_PROFILE = profile;
  if (pii === undefined) delete process.env.PI_PII_MODE;
  else process.env.PI_PII_MODE = pii;
}

test("work Drive launches only the pinned upstream read-only Drive server in work mode", () => {
  mode("work");
  const h = setup();
  h.handlers.get("session_start")?.();
  const config = h.servers.get("work-drive");
  expect(config).toBeDefined();
  expect(config && "command" in config && config.command).toBe("uvx");
  expect(config && "command" in config && config.args).toContain("workspace-mcp==2.1.0");
  expect(config && "command" in config && config.args).toContain("--read-only");
  expect(config && "command" in config && config.env?.USER_GOOGLE_EMAIL).toBe("drew@sheerhealth.com");
  expect(config && "command" in config && config.env?.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
});

test("personal and PII mode do not register a Drive process", () => {
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
});

test("profile changes unregister the server and every direct or nested call is guarded", () => {
  mode("work");
  const h = setup();
  h.handlers.get("session_start")?.();
  const call = h.handlers.get("tool_call");
  expect(call).toBeDefined();
  const event = {
    toolName: "mcp__work_drive__search_drive_files",
    input: { user_google_email: "drew@sheerhealth.com" },
  };
  expect(call?.(event)).toBeUndefined();
  expect(call?.({ ...event, input: { user_google_email: "other@example.com" } })?.block).toBe(true);
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
