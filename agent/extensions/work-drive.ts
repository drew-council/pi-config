import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const server = "work-drive";
const email = "drew@sheerhealth.com";

export default function workDrive(pi: ExtensionAPI, agentDir = getAgentDir()) {
  let registered = false;
  const allowed = () => process.env.PI_AUTH_PROFILE === "work" && process.env.PI_PII_MODE !== "1";
  const sync = () => {
    if (!allowed()) {
      if (registered) pi.unregisterMcpServer(server);
      registered = false;
      return;
    }
    const secrets = join(agentDir, "..", "secrets");
    if (registered || !existsSync(join(secrets, "work-drive-client.json"))) return;
    pi.registerMcpServer(server, {
      command: "uvx",
      args: [
        "workspace-mcp==2.1.0",
        "--single-user",
        "--tools",
        "drive",
        "--read-only",
        "--tool-tier",
        "core",
        "--disabled-tools",
        "start_google_auth",
      ],
      cwd: agentDir,
      env: {
        GOOGLE_CLIENT_SECRET_PATH: join(secrets, "work-drive-client.json"),
        WORKSPACE_MCP_CREDENTIALS_DIR: join(secrets, "work-drive"),
        USER_GOOGLE_EMAIL: email,
      },
      description:
        "Search and read work Google Drive, including Google Docs, Sheets, Slides, Office files, and PDFs. Read-only, drew@sheerhealth.com. Not for PHI.",
      exposure: "direct",
    });
    registered = true;
  };
  pi.on("session_start", sync);
  pi.on("before_agent_start", sync);
  pi.events.on("auth-profile:changed", sync);
  pi.on("tool_call", (event) => {
    if (!event.toolName.startsWith("mcp__work_drive__")) return;
    if (!allowed()) return { block: true, reason: "Work Drive is only available in work mode, outside PII-safe mode." };
    const input = event.input as { user_google_email?: string };
    if (input.user_google_email && input.user_google_email.toLowerCase() !== email) {
      return { block: true, reason: `Work Drive is restricted to ${email}.` };
    }
  });
  pi.on("session_shutdown", () => {
    if (registered) pi.unregisterMcpServer(server);
    registered = false;
  });
}
