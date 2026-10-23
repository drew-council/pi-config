# Personal ChatGPT subscription login

Use `/log-me-in openai`, then choose **Browser login / reauthenticate** for
Pi's newer **Sign in with ChatGPT** subscription flow. This explicitly selects
OAuth, not the OpenAI API-key method. If currently using work, the menu asks for
approval before switching profiles; the conversation is retained. Use `/new`
if the conversation should not cross accounts.

The login uses Pi's stable installation device ID and browser callback (port
1455). If a remote callback cannot complete, paste the full final redirect URL
when prompted. Cancel other unfinished Pi logins if the port is occupied.
Esc cancels; login is never started by setup or provider discovery.

`openai` is personal-only. An existing `openai` API key is preserved when
checking saved logins: choosing subscription login explicitly replaces that
provider's single credential after a successful login. Use the picker to
select/save a newer model or effort only when desired.

`/usage` shows a **ChatGPT subscription (openai)** card with:

- **Plan usage**: a link to `https://chatgpt.com/settings/usage`. OpenAI exposes
  plan usage only in that settings UI; the direct-grant token is scoped to
  `api.openai.com` and cannot query a usage endpoint.
- **Local Pi activity (not plan quota)**: requests, tokens, and estimated cost
  recorded from completed `openai` responses in the last 5 hours and 7 days,
  stored only as counts in `agent/chatgpt-local-usage.jsonl`.

Usage display performs no token refresh or credential mutation.

Host contract checked against Pi 1.0.4 installed `docs/providers.md`,
`docs/models.md`, auth types, `auth/oauth/openai-chatgpt.js`, and native interactive
login's `getDeviceId` option. Fast mode supports the `openai` provider without
changing model or effort selection.
