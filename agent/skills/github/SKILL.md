---
name: github
description: Work with the sheerhealth/sheer GitHub repo, covering pull requests, issues, epics, the sprint board, CI runs, discussions, the wiki, and releases. Use for any request that touches GitHub in this repo, however small, even when a single `gh` command looks sufficient. The bundled CLI is the mandatory primary interface; use raw `gh` only for unsupported operations. Trigger on any mention of a PR, issue, epic, sprint, board, triage, review comment, check, CI, workflow, action, run, discussion, spec, TDR, wiki page, release, tag, or deploy.
---

# GitHub for sheerhealth/sheer

`sheer-gh` is the primary interface to GitHub. **Use it whenever it supports the operation, including read-only discovery.** Use raw `gh` only for unsupported operations, then return to `sheer-gh`.

## Setup and invocation

Requires Go 1.26+ and an authenticated `gh`. The first run compiles dependencies and may take several seconds.

`sheer-gh` is on `PATH` in agent bash calls. Invoke it directly:

```sh
sheer-gh ci latest ci
```

Read the relevant reference and `sheer-gh <group> --help` before acting.

| Need | Reference | Group |
| --- | --- | --- |
| Work, sprints, status board | [references/issues-sprints.md](references/issues-sprints.md) | `issue`, `sprint` |
| PR descriptions and review threads | [references/pull-requests.md](references/pull-requests.md) | `pr` |
| Specs, decisions, ideas | [references/discussions.md](references/discussions.md) | `discussion` |
| Runbooks and setup guides | [references/wiki.md](references/wiki.md) | `wiki` |
| Releases and deployment state | [references/releases.md](references/releases.md) | `release` |
| CI failures and reruns | [references/ci.md](references/ci.md) | `ci` |

Stacked PRs use the separate gh-stack skill.

## Rules

- Confirm before comments, replies, new issues or discussions, wiki pushes, or publishing a release. Draft PRs and draft releases do not need confirmation.
- Agent-written comments carry the CLI's attribution line unless explicitly disabled.
- Follow repository templates. The CLI fetches them from GitHub's default branch.
- Link every PR to an issue with a closing keyword. CI rejects PRs over 50 changed lines without an issue unless labeled `debt`.
- Board writes need the `project` token scope. On failure run `gh auth refresh -s project`.
- `--dry-run` previews mutations. `--json` switches structured row output to JSON.
