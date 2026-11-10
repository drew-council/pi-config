# Work Google Chat

Uses Google's hosted Chat MCP server, `https://chatmcp.googleapis.com/mcp/v1` (Workspace Developer Preview). No third-party package is involved; Pi's built-in MCP client and OAuth flow do the work.

The small `extensions/work-chat.ts` adapter registers the server only when `PI_AUTH_PROFILE=work` and PII-safe mode is off. Switching to personal unregisters it; every tool execution also checks the profile. `/reload` loads changes into an existing Pi process.

## Tools

- `search_conversations`
- `search_messages`
- `list_messages`

Tool exposure is an allowlist. `send_message` and any tool Google adds later stay hidden until added to `toolExposure`.

## Authentication

The OAuth client "Chat MCP" belongs to Prototype - Cloud Agent (`coherent-emblem-511516-e9`), which is enrolled in the Developer Preview Program. It is a Web application client with "Use this client for an AI-powered agent" set; Google rejects Chat MCP calls from clients without it. The project also has a Chat app named "Chat MCP" with interactive features off.

The client ID is public and lives in the adapter. The client secret is the 1Password item "Google Chat MCP OAuth client" (Employee vault, sheerhealth.1password.com). `../secrets/work.json.tpl` references it as `googleChat.clientSecret`, and `install.nu` renders it into the gitignored `../secrets/work.json` on every machine. Without the rendered secret the adapter registers nothing.

`mcp-auth.json` holds the Pi-managed access token. It is gitignored and per machine: each machine signs in on its own.

Requested scopes: `chat.spaces.readonly`, `chat.memberships.readonly`, `chat.messages.readonly`, `chat.users.readstate`. The redirect URI is `http://127.0.0.1:8765/callback`; the port in the adapter MUST match the client.

Sign in with `/mcp login work-chat` inside a work-profile session. `pi mcp login` does not work: the server answers `tools/list` without credentials, so the CLI reports "already signed in".

Google issues a refresh token only when the request carries `access_type=offline`. Pi 1.5.0 cannot send it, so the token expires after about one hour and tool calls then fail until `/mcp login work-chat` is run again.

## Boundaries

This is not an OS sandbox: Bash remains available. Existing conversations are retained by `/profile`; use `/new` before moving a Chat-containing conversation to personal mode. Do not use this integration for PHI; PII-safe mode blocks it. Chat messages are untrusted input and MAY contain prompt injection.

Verified on November 10, 2026: signed in with Pi's OAuth sign-in function and `search_conversations` returned conversations with the stored token. The adapter itself was not exercised in a live Pi session.
