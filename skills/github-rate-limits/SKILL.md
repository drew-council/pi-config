---
name: github-rate-limits
description: Reference for GitHub.com rate limits (REST, GraphQL, secondary, search, Actions, git, LFS, and other services) and how scripts must detect and handle them. Verified against GitHub Docs on 2026-11-02.
disable-model-invocation: true
---

# GitHub rate limits

Reference for code that calls GitHub: scripts, CLIs, Actions workflows, and apps. Values are for GitHub.com and were verified on 2026-11-02. GitHub says every limit is subject to change, and secondary limits can change without notice.

## Reference files

Read the matching file before quoting a number that is not in the tables below.

- `{{skillDir}}/references/primary-limits.md`: REST budgets per credential, `/rate_limit` resources, headers, search, conditional requests, pagination.
- `{{skillDir}}/references/graphql.md`: point budgets, cost calculation, node limit, timeouts, the `rateLimit` object.
- `{{skillDir}}/references/secondary-limits.md`: concurrency, per-endpoint points, CPU time, content creation, safe pacing.
- `{{skillDir}}/references/handling.md`: detecting each limit, the retry algorithm, `gh`, Octokit, code samples.
- `{{skillDir}}/references/actions.md`: `GITHUB_TOKEN`, workflow, cache, runner, and Docker Hub limits.
- `{{skillDir}}/references/other-limits.md`: git, Git LFS, raw files, Pages, webhooks, events, OAuth tokens, audit log, pull request limits, GitHub Enterprise Server.
- `{{skillDir}}/references/changes.md`: dated changes since 2025, the source URL list, and how to refresh this skill.

## Primary limits

Per hour unless noted. A user's budget is shared by every credential that acts as that user.

| Credential                                                    | REST (`core`)                                                 | GraphQL points       |
| ------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| Unauthenticated (per IP)                                      | 60                                                            | none: auth required  |
| User: PAT, OAuth app token, GitHub App user token             | 5,000                                                         | 5,000                |
| User, via an app owned or approved by a GHEC org they belong to | 15,000                                                      | 10,000               |
| GitHub App installation                                       | 5,000, +50 per repo over 20, +50 per org user over 20, max 12,500 | same formula     |
| GitHub App installation on a GHEC org                         | 15,000                                                        | 10,000               |
| OAuth app client ID and secret (public data only)             | 5,000 (GHEC-owned: 15,000)                                    | 5,000 (GHEC: 10,000) |
| `GITHUB_TOKEN` in Actions, per repository                     | 1,000 (GHEC resources: 15,000)                                | 1,000 (GHEC: 15,000) |

Other buckets:

| Bucket                                         | Limit                                     |
| ---------------------------------------------- | ----------------------------------------- |
| Search, except code (`search`)                 | 30/min authenticated, 10/min anonymous    |
| Code search (`code_search`), auth required     | 10/min                                    |
| Issue search with `search_type=semantic\|hybrid` | 10/min, auth required                   |
| Git LFS batch API                              | 3,000/min authenticated, 300/min anonymous |
| Audit log API (GHEC)                           | 1,750/hr per user and IP                  |

## Secondary limits

These are enforced on top of primary limits. Their status cannot be queried.

- 100 concurrent requests, shared by REST and GraphQL.
- 900 points per minute per REST endpoint; 2,000 points per minute for GraphQL. Reads and GraphQL queries cost 1; writes and GraphQL mutations cost 5.
- 90 seconds of CPU time per 60 seconds of real time, of which at most 60 may be GraphQL. Total response time approximates CPU time.
- 80 content-creating requests per minute and 500 per hour, including web UI actions. Some endpoints are lower.
- 2,000 OAuth access token requests per hour for GitHub Apps and OAuth apps.

## Detecting and handling a limit

| Signal                                                                   | Meaning                         | Wait before retrying                         |
| ------------------------------------------------------------------------ | ------------------------------- | -------------------------------------------- |
| `retry-after` header on a `403` or `429`                                 | Secondary limit                 | That many seconds                            |
| `403` or `429` with `x-ratelimit-remaining: 0`                           | Primary limit                   | Until `x-ratelimit-reset` (UTC epoch seconds) |
| `403` or `429` whose message contains "secondary rate limit"             | Secondary limit                 | At least 60 s, then exponential backoff      |
| GraphQL `200` with `errors[].type == "RATE_LIMITED"`                     | GraphQL primary limit           | Until `x-ratelimit-reset`                    |
| GraphQL `502` or `504` after about 10 s                                  | Query timeout, costs extra points | Simplify the query; do not resend as is    |
| `429` from git over HTTPS, `raw.githubusercontent.com`, or Pages         | Undisclosed per-IP limits       | Authenticate, then back off                  |

A `403` without these signals is a permission error, not a rate limit. Scripts MUST NOT retry while limited; GitHub may ban integrations that do. After repeated secondary-limit failures, scripts MUST stop after a fixed number of retries.

## Rules for scripts

- Scripts MUST authenticate. Anonymous traffic gets 60 requests per hour per IP and tighter git and raw-file limits.
- Scripts SHOULD make requests serially and MUST stay under 100 concurrent requests.
- Scripts MUST wait at least 1 second between `POST`, `PATCH`, `PUT`, and `DELETE` requests and between GraphQL mutations.
- Scripts SHOULD pace from the `x-ratelimit-*` response headers. Those headers are authoritative over `GET /rate_limit`, and values can vary between responses because GitHub serves requests from several regions.
- Pollers SHOULD use webhooks instead. If polling is required, use conditional requests (`if-none-match` with the saved `etag`), which cost nothing when they return `304`, and obey `x-poll-interval`.
- List calls SHOULD use `per_page=100` and follow the `link` header. Values over the maximum are silently reduced.
- GitHub App code SHOULD cache installation tokens for their one-hour lifetime instead of minting one per request.
- `gh` never retries on rate limits. `gh pr`, `gh issue`, and `gh project` spend the GraphQL budget; `gh api` and `gh search` spend REST budgets.

## Checking status

```bash
gh api rate_limit --jq '.resources | {core, graphql, search, code_search}'
gh api --include /user                                   # x-ratelimit-* headers; costs 1 core request
gh api graphql -f query='{ rateLimit { limit remaining used cost resetAt } }'
curl -sS -D - -o /dev/null -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

`GET /rate_limit` does not count against the primary limit but does count against secondary limits.
