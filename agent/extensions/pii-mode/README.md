# PII-safe mode

A one-way switch for working with PII/PHI. While it is on, session data can
only reach approved models (by default Vertex AI Gemini, `google-vertex` with
ids starting `gemini-`), tools that would send it elsewhere are blocked, and
nothing from the session is written to the session directory.

```text
/pii          # this process: start a fresh in-memory PII-safe session
pi --pii      # start in PII-safe mode
PI_PII_MODE=1 pi
```

There is no way to turn it off. Exit pi to leave it, which also discards the
in-memory transcript. `/pii` waits for the agent to go idle and starts a fresh
session, without asking for confirmation. The previous session file is left as
it is and holds only what was said before.

## What it does

- **Models.** Requests to any other model are refused when pi prepares them
  (`ModelRuntime.prepareRequest`). That covers agent turns, compaction, branch
  summaries, the cache warmer, and extension calls through `ctx.modelRegistry`
  such as a background command reviewer. Other models are hidden from the
  pickers, scoped models and cycling. Entering switches to `defaultModel`, or
  the first available allowed model, and selecting another model reverts the
  choice. Classifier and image models are always refused.
- **Tools.** Only `allowedTools` can run. This is checked on every call,
  including nested codemode calls. Every other tool is also removed from the
  active set before each prompt. That blocks subagents (child transcripts and
  artifacts on disk, external CLI agents), web search, MCP tools and connectors
  such as Composio.
- **Session files.** The session keeps entries in memory only, exactly as
  `--no-session` does. `/new`, `/fork` and `/clone` stay in memory. `/resume`
  and `/import` are refused, since they reopen a file that pi would append to.
  Starting with `--pii` together with `--continue`, `--resume` or `--session`
  on a non-empty session exits instead. Pi creates the empty per-directory
  session folder before extensions load, so `--pii` still leaves that folder
  (its name is the working directory), but no file in it.
- **Transcript commands.** `/share`, `/export` and `/bug` are refused.
- **Temporary files.** `TMPDIR` points at a private (0700) `pi-pii-<pid>-*`
  directory, which is deleted on exit. Pi's full output for truncated tool
  results, external-editor files, and `mktemp` in bash all land there. A child
  that inherited `TMPDIR` can recreate the directory after the exit cleanup,
  for example pi's own `npm root -g` lookup or a background job started from
  bash. So does a crash. Every pi start removes directories whose process has
  exited, in or out of PII-safe mode.
- **System prompt.** Adds a `pii_safe_mode` section with rules for handling
  PII ([prompt.ts](prompt.ts)).
- **Status.** The footer shows `PII-safe`.

If the configuration is invalid, or a pi internal it relies on has changed,
`/pii` refuses to start and `--pii` exits. It never half-enables.

## Contract for other extensions

PII-safe mode is `process.env.PI_PII_MODE === "1"`. Bash commands and pi
processes started from the session inherit it, and such pi processes start in
PII-safe mode themselves. An extension that persists user content outside the
session (prompt history, logs, caches) should skip writing while it is set.
This repository's `history` extension does.

## Configuration

Optional `~/.pi/agent/pii-mode.json`. Each key replaces its default:

```json
{
  "models": [{ "provider": "google-vertex", "id": "^gemini-" }],
  "defaultModel": "google-vertex/gemini-3.8-flash",
  "allowedTools": ["read", "bash", "edit", "write", "find", "grep", "ls", "codemode", "ask_user"]
}
```

`models[].id` is a regular expression. Other extensions' model policies still
apply on top: with this repository's blacklist, `google-vertex/gemini-3.8-flash`
is the only allowed model.

## Known limitations

- **Bash can reach the network.** A command can still send data anywhere, for
  example with `curl`. The system prompt forbids it, but only an OS sandbox
  could enforce it.
- Files the agent writes into the repository or home directory are not
  tracked. The system prompt asks it to use `$TMPDIR` and to report anything else.
- Terminal scrollback, the clipboard, terminal multiplexers, and extensions
  that send UI text elsewhere are out of scope.
- Neovim's shada file (registers, command history) when using an embedded
  Neovim editor.
- `/share`, `/export` and `/bug` are only refused in the interactive TUI. RPC
  clients can still export.
- Extensions are trusted code. This is a policy, not a sandbox against an
  extension that calls a provider or writes files directly. Some extensions do
  that only for their own current model. For example, `pi-claude-bridge` runs
  compaction and branch summaries through Claude Code when a bridge model is
  selected. They stay inactive because PII-safe mode keeps the current model
  on an allowed one.
- It relies on pi internals (`ModelRuntime.prepareRequest`,
  `SessionManager.persist`, `InteractiveMode` command handlers) and checks
  them at load.

## Web search

`web_search` and `web_research` (`@bizmyth/pi-vertex-gemini-search`) are
blocked. They ground Gemini with Google Search and `url_context`, and both
fall outside Vertex AI's zero data retention. Google Search grounding keeps
query-derived logs for up to three days, and `url_context` handles URLs and
fetched content as Service Data. To allow search, add a mode to that package
(on when `PI_PII_MODE=1`) that:

1. sends `tools: [{ enterpriseWebSearch: {} }]` (Web Grounding for
   Enterprise, which does not log customer data) instead of `googleSearch`;
2. drops `urlContext` and the system prompt's instructions to read URLs; and
3. runs on a model that supports it, such as `gemini-3.8-flash`.

Then add both tools to `allowedTools`. Have compliance confirm Web Grounding
for Enterprise first: Google's page describes it as for regulated industries
but does not name HIPAA.

- <https://cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention>
- <https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/web-grounding-enterprise>
