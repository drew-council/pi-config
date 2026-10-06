# Personal ChatGPT subscription login

Use `/log-me-in openai`, then choose **Browser login / reauthenticate** for
Pi's newer **Sign in with ChatGPT** subscription flow. This explicitly selects
OAuth, not the OpenAI API-key method. If currently using work, the menu asks for
approval before switching profiles; the conversation is retained. Use `/new`
if the conversation should not cross accounts.

The login uses Pi's stable installation device ID and browser callback (port
1455). If a remote callback cannot complete, paste the full final redirect URL
when prompted. Cancel other unfinished Pi/Codex logins if the port is occupied.
Esc cancels; login is never started by setup or provider discovery.

`openai` is personal-only. Existing `openai-codex` credentials and saved model /
effort defaults remain unchanged. `/log-me-in openai-codex` still connects the
legacy subscription provider. Use the picker to select/save a newer model only
when desired; neither credentials nor model defaults are migrated automatically.
An existing `openai` API key is also preserved: choosing subscription login
explicitly replaces that provider's single credential after a successful login.

`/usage` cannot measure the newer direct ChatGPT grant: Pi stores an issued
`clientId` and `scopes` (including `chatgpt.tokens.use.direct`), not the legacy
Codex `accountId`. Its access token is intended for `api.openai.com`; it is never
sent to the legacy `chatgpt.com/backend-api/wham/usage` endpoint. When actual
legacy Codex OAuth credentials exist, `/usage` continues reporting **legacy
usage**, which does not measure the newer direct grant. No token refresh or
credential mutation is performed by usage reporting.

Host contract checked against Pi 1.0.4 installed `docs/providers.md`,
`docs/models.md`, auth types, `auth/oauth/openai-chatgpt.js`, and native interactive
login's `getDeviceId` option. Fast mode continues supporting both provider IDs
without changing model or effort selection.
