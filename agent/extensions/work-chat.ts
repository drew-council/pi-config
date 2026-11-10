import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const server = "work-chat";
const url = "https://chatmcp.googleapis.com/mcp/v1";
// OAuth client "Chat MCP" in GCP project coherent-emblem-511516-e9. The ID is public; the secret is in 1Password.
const clientId = "186811340919-hi3t6mp8dht5jao1o84mc9rrilkdu8fm.apps.googleusercontent.com";
// MUST match a redirect URI of the OAuth client: http://127.0.0.1:8765/callback.
const callbackPort = 8765;
const scope = ["chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.users.readstate"]
  .map((name) => `https://www.googleapis.com/auth/${name}`)
  .join(" ");

/** Whether `secrets/work.json` was generated with the Chat client secret. */
function hasClientSecret(secretsFile: string): boolean {
  try {
    const secret = (JSON.parse(readFileSync(secretsFile, "utf8")) as { googleChat?: { clientSecret?: unknown } })
      .googleChat?.clientSecret;
    return typeof secret === "string" && secret.trim() !== "" && !secret.includes("op://");
  } catch {
    return false;
  }
}

export default function workChat(pi: ExtensionAPI, agentDir = getAgentDir()) {
  let registered = false;
  const allowed = () => process.env.PI_AUTH_PROFILE === "work" && process.env.PI_PII_MODE !== "1";
  const sync = () => {
    if (!allowed()) {
      if (registered) pi.unregisterMcpServer(server);
      registered = false;
      return;
    }
    const secretsFile = join(agentDir, "..", "secrets", "work.json");
    if (registered || !hasClientSecret(secretsFile)) return;
    pi.registerMcpServer(server, {
      url,
      oauth: {
        clientId,
        clientSecret: `!jq -r .googleChat.clientSecret '${secretsFile}'`,
        callbackPort,
        scope,
      },
      description:
        "Search and read work Google Chat spaces, DMs, and messages. Read-only, drew@sheerhealth.com. Not for PHI.",
      // Allowlist: tools Google adds later stay hidden until reviewed.
      exposure: "hidden",
      toolExposure: {
        search_conversations: "direct",
        search_messages: "direct",
        list_messages: "direct",
      },
    });
    registered = true;
  };
  pi.on("session_start", sync);
  pi.on("before_agent_start", sync);
  pi.events.on("auth-profile:changed", sync);
  pi.on("tool_call", (event) => {
    if (!event.toolName.startsWith("mcp__work_chat__")) return;
    if (!allowed()) return { block: true, reason: "Work Chat is only available in work mode, outside PII-safe mode." };
  });
  pi.on("session_shutdown", () => {
    if (registered) pi.unregisterMcpServer(server);
    registered = false;
  });
}
