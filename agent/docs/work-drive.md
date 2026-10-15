# Work Google Drive

Uses the maintained [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) package, pinned to 2.1.0 and run locally through `uvx`. No Google Developer Preview or hosted connector is involved.

The small `extensions/work-drive.ts` adapter registers the upstream MCP server only when `PI_AUTH_PROFILE=work` and PII-safe mode is off. Switching to personal unregisters it; every tool execution also checks the profile and the requested Google account. `/reload` loads changes into an existing Pi process.

## Tools

- `search_drive_files`
- `get_drive_file_content` — reads Google Docs, Sheets (CSV export), Slides, Office documents, PDFs with extractable text, and ordinary text files
- `get_drive_file_download_url`
- `get_drive_shareable_link`

The upstream server is launched with `--read-only --tools drive --tool-tier core`. Google additionally enforces `drive.readonly` on the authorization. The server's authentication-creation tool is disabled, and the account is restricted to `drew@sheerhealth.com`.

## Authentication

The OAuth client belongs to Prototype - Cloud Agent (`coherent-emblem-511516-e9`). Private files are gitignored:

- `../secrets/work-drive-client.json`: Google OAuth client
- `../secrets/work-drive/`: upstream-managed credentials and refresh token

The already-approved read-only authorization was imported into the upstream credential store; the upstream package handles refresh. No custom OAuth flow or Drive reader is maintained here. Other machines need these private files transferred securely; never commit them. No secrets are embedded in the adapter or MCP configuration.

## Boundaries

This is not an OS sandbox: Bash remains available. Existing conversations are retained by `/profile`; use `/new` before moving a Drive-containing conversation to personal mode. Do not use this integration for PHI; PII-safe mode blocks it.

Verified end to end on October 15, 2026: searched Drive and read the Google Doc "onboarding notes" using upstream MCP tools, not custom API calls.
