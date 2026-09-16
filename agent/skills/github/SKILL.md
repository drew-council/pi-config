---
name: github
description: Work with the sheerhealth/sheer GitHub repo, covering pull requests, issues, epics, the sprint board, CI runs, discussions, the wiki, and releases. Use for any request that touches GitHub in this repo, however small, even when a single `gh` command looks sufficient. The bundled scripts are the mandatory primary interface; use raw `gh` only for unsupported operations. Trigger on any mention of a PR, issue, epic, sprint, board, triage, review comment, check, CI, workflow, action, run, discussion, spec, TDR, wiki page, release, tag, or deploy.
---

# GitHub for sheerhealth/sheer

The scripts in this skill are the primary interface to GitHub. **You MUST use a bundled script when it supports the operation, including read-only discovery.** Do not replace a script command with a familiar raw `gh` command just because it looks simpler.

For every GitHub task:

1. Read the README for the relevant area below and check the adjacent script's `--help`.
2. Use the script for every supported step, including finding IDs, inspecting state, and making changes.
3. Use raw `gh` only for an operation the scripts do not support. If raw `gh` is needed for one step, return to the script for subsequent supported steps rather than staying in raw-CLI exploration mode.

The scripts use the `gh` CLI internally. The repo is `sheerhealth/sheer` under the `sheerhealth` org, default branch `main`, and the shared `lib.sh` supplies that context. For an unsupported operation, add `--repo sheerhealth/sheer` when outside a checkout, prefer `--json` with `--jq` over parsing text, and use `gh api --paginate` for lists past 100 items.

## Where things live

| Need | Lives in | Read |
| --- | --- | --- |
| Work to do, sprints, status board | Issues and org project 9 "Sheer" | [issues-sprints/README.md](issues-sprints/README.md) |
| Code review, PR descriptions, review threads | Pull requests | [pull-requests/README.md](pull-requests/README.md) |
| Specs, decisions, ideas, questions | Discussions | [discussions/README.md](discussions/README.md) |
| Runbooks, setup guides, process docs | Wiki, a git repo of markdown pages | [wiki/README.md](wiki/README.md) |
| What is deployed, cutting a release | Releases with CalVer tags | [releases/README.md](releases/README.md) |
| Why CI failed, rerunning it | GitHub Actions | [ci/README.md](ci/README.md) |

Stacked PRs are handled by the separate gh-stack skill. This skill covers everything else.

Each README documents the scripts that sit next to it. They share `lib.sh`, default to `sheerhealth/sheer`, and take `--help`. The script-first rule applies to ordinary `gh pr`, `gh issue`, `gh run`, and `gh workflow` commands too, not only to hand-written GraphQL.

For GitHub Actions, start with `ci/ci.sh`: `list` and `latest` discover runs without a PR number or run ID, `jobs` discovers job names and IDs, and `log` retrieves logs from successful or failed runs and jobs. For example, use `ci/ci.sh latest autoformat` rather than `gh run list`, then `ci/ci.sh log <run-id> apply` rather than `gh run view`.

## Rules for every interaction

- Confirm with the user before anything other people will see: comments, replies, new issues or discussions, wiki pushes, publishing a release. Draft PRs and draft releases do not need confirmation.
- Comments written by an agent carry an attribution line. The scripts add one by default.
- Follow the templates in `.github/`. The scripts read them from there, so there is nothing else to keep in sync.
- Link the issue from every PR with a closing keyword. A workflow rejects PRs over 50 changed lines that mention no issue.
- Board writes need the `project` token scope. If they fail, run `gh auth refresh -s project`.
