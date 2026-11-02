# Primary limits

Primary limits are hourly (or per-minute) budgets per credential and resource bucket. Values below are for GitHub.com as of 2026-11-02.

## REST budgets by credential

### Unauthenticated

- 60 requests per hour, keyed on the originating IP address.
- Only public data is reachable.
- Since 2025-05-08, anonymous HTTPS clones and `raw.githubusercontent.com` downloads have tighter limits too. See `other-limits.md`.

### Users

- 5,000 requests per hour.
- The budget is per user, not per token. Classic and fine-grained PATs, OAuth app tokens, and GitHub App user access tokens all draw from it.
- A GitHub App owned by a GitHub Enterprise Cloud (GHEC) organization gets 15,000 per hour when acting for a user.
- An OAuth app owned or approved by a GHEC organization gets 15,000 per hour when the user is a member of that organization.
- Higher-limit apps drain the shared budget. GitHub's example: if a 15,000-limit app makes 10,000 requests for a user, that user's PATs have no budget left even though the app still has 5,000.

### GitHub App installations

Installation access tokens get their own budget:

- At least 5,000 requests per hour.
- Plus 50 per hour for each repository over 20 in the installation.
- Plus 50 per hour for each organization user over 20.
- At most 12,500 per hour.
- Installations on a GHEC organization get a flat 15,000 per hour.

Example: an installation on a non-GHEC org with 50 repositories and 30 users gets 5,000 + 30 × 50 + 10 × 50 = 7,000 per hour.

Installation tokens expire after one hour. Minting them counts toward the 2,000 per hour OAuth token secondary limit, so cache them.

### OAuth apps

- User access tokens from an OAuth app use the user's budget.
- Basic auth with the app's client ID and secret (`curl -u CLIENT_ID:CLIENT_SECRET`) can read public data at 5,000 per hour per app, or 15,000 if a GHEC organization owns the app. The client secret MUST NOT ship in client-side or on-device code.

### `GITHUB_TOKEN` in Actions

- 1,000 requests per hour per repository.
- 15,000 per hour per repository for requests to resources in a GHEC account.

## Buckets reported by `GET /rate_limit`

`GET /rate_limit` returns one object per bucket under `resources`. Calling it does not count against the primary limit but does count against secondary limits.

Limits observed on a personal (non-GHEC) account on 2026-11-02. The window was inferred from the reset time of an unused bucket. Enterprise and app credentials see different values for some buckets.

| Bucket                        | Limit  | Window | Covers                                                        |
| ----------------------------- | ------ | ------ | ------------------------------------------------------------- |
| `core`                        | 5,000  | 1 hour | All REST endpoints without their own bucket                   |
| `graphql`                     | 5,000  | 1 hour | GraphQL points                                                |
| `search`                      | 30     | 1 min  | REST search, except code                                      |
| `code_search`                 | 10     | 1 min  | `GET /search/code`                                            |
| `integration_manifest`        | 5,000  | 1 hour | `POST /app-manifests/{code}/conversions`                      |
| `actions_runner_registration` | 10,000 | 1 hour | Self-hosted runner registration                               |
| `scim`                        | 15,000 | 1 hour | SCIM provisioning                                             |
| `dependency_snapshots`        | 100    | 1 min  | Dependency submission API                                     |
| `dependency_sbom`             | 100    | 1 min  | SBOM export from the dependency graph                         |
| `code_scanning_autofix`       | 10     | 1 min  | Code scanning autofix                                         |
| `audit_log`                   | 1,750  | 1 hour | Audit log API                                                 |
| `audit_log_streaming`         | 15     | 1 hour | Audit log streaming API                                       |
| `copilot_usage_records`       | 1,750  | 1 hour | Copilot usage records                                         |
| `enterprise_token_inventory`  | 1,750  | 1 hour | Enterprise token inventory                                    |
| `source_import`               | 100    | 1 min  | No endpoints; GitHub will remove it in the next API version   |

Removed fields:

- `code_scanning_upload` was removed on 2026-05-19. SARIF uploads count against `core`. Some docs pages still list it.
- The top-level `rate` object duplicates `resources.core`. API version `2026-03-10` removes it. Requests without an `X-GitHub-Api-Version` header still get `2022-11-28`, which keeps it. Read `resources.core`.

Rate limit status follows the requester and the bucket, not the hostname. Requests through an API hostname or a web hostname can count against the same limit.

## Response headers

Every REST and GraphQL response carries:

| Header                  | Meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `x-ratelimit-limit`     | Maximum requests (REST) or points (GraphQL) per window       |
| `x-ratelimit-remaining` | Left in the current window                                   |
| `x-ratelimit-used`      | Used in the current window                                   |
| `x-ratelimit-reset`     | Window reset time, UTC epoch seconds                         |
| `x-ratelimit-resource`  | Bucket the request counted against, e.g. `core` or `graphql` |

Rate-limited responses MAY also carry `retry-after` (seconds). Polling endpoints MAY carry `x-poll-interval` (seconds).

- The headers are authoritative. If they disagree with `GET /rate_limit`, trust the headers.
- Because GitHub serves requests from several regions, `x-ratelimit-remaining` can rise between two responses in the same window. Code SHOULD pace from the headers but MUST NOT depend on an exact remaining count.

## Exceeding a primary limit

- REST returns `403` or `429` with `x-ratelimit-remaining: 0`.
- The body message typically reads `API rate limit exceeded for user ID <id>.` Anonymous requests read `API rate limit exceeded for <ip>.` followed by a note that authenticated requests get a higher limit.
- Do not retry until after `x-ratelimit-reset`.
- GraphQL is different: see `graphql.md`.

## Search

- The `search` bucket allows 30 requests per minute authenticated and 10 per minute anonymous.
- `GET /search/code` requires authentication and allows 10 per minute (`code_search`).
- `GET /search/issues` with `search_type=semantic` or `search_type=hybrid` requires authentication and allows 10 per minute.
- Each search returns at most 1,000 results, at up to 100 per page.
- A query MUST be at most 256 characters, excluding operators and qualifiers, and MUST NOT use more than five `AND`, `OR`, or `NOT` operators. Violations return `422 Validation Failed`.
- A query searches at most 4,000 matching repositories.
- Slow queries stop early and return partial matches with `incomplete_results: true`.
- Code search covers only default branches and files smaller than 384 KB, and needs at least one search term.
- `GET /search/users` does not accept authentication.
- To read more than 1,000 results, split the query into narrower ranges, such as `created:` date windows.

## Conditional requests

- Most endpoints return `etag`, and many return `last-modified`.
- Send `if-none-match: <etag>` or `if-modified-since: <last-modified>`. A `304 Not Modified` response does not count against the primary limit when the request carries a valid `Authorization` header.
- A `304` comes back only when the representation is unchanged. Use identical parameters each poll, filter server side (e.g. `?head=OWNER:BRANCH`), and keep a stable sort; `sort=updated` reshuffles pages.
- Conditional `POST`, `PUT`, `PATCH`, and `DELETE` are unsupported unless an endpoint says otherwise.

## Pagination

- Follow the `link` header (`rel="next"`). Do not build page URLs by hand.
- `per_page` maxes out at 100 for most endpoints. Larger values are silently reduced, with no error.
- `gh api --paginate` and Octokit's `paginate` request pages sequentially. Each page costs one request.

## Getting a higher limit

1. Authenticate.
2. Replace PAT automation in organizations with a GitHub App installation, whose budget scales with repositories and users.
3. Apps owned by GHEC organizations get 15,000 REST requests or 10,000 GraphQL points per hour.
