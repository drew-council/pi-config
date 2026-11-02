# Other GitHub limits

Limits outside the REST and GraphQL APIs that scripts run into.

## Git over HTTPS and SSH

GitHub.com publishes no numeric rate limit for git operations. What is documented:

- Since 2025-05-08, anonymous HTTPS clones have tighter limits; the numbers are not published. Over the limit, expect `429` or failed clones. Authenticate clones in CI and scripts (`gh auth setup-git`, a credential helper, or `https://x-access-token:TOKEN@github.com/...`).
- Recommended maximums per repository. Exceeding them risks throttling and degraded performance:

| Activity                    | Recommendation                    | Enforced                    |
| --------------------------- | --------------------------------- | --------------------------- |
| Reads (fetch, clone)        | 15 operations per second          | No; throttled under load    |
| Pushes                      | 6 per minute                      | No                          |
| Push size                   | n/a                               | 2 GB per push               |
| Single object               | 1 MB                              | 100 MB                      |
| On-disk size (`.git`)       | 10 GB                             | No                          |
| Pull request merges         | 1 per minute                      | No                          |
| Open PRs against one branch | 1,000                             | No                          |

- Shallow clones cost the server less than full clones. CI SHOULD use them or a cache server.
- GitHub says it does not throttle bandwidth per user. Slowness at certain times of day is usually network congestion.

## Git LFS

- The LFS batch API has its own bucket: 3,000 requests per minute authenticated and 300 per minute anonymous.
- Each batch request covers up to 100 objects by default, so that is 300,000 or 30,000 objects per minute.
- LFS storage and bandwidth are billed separately.

## Raw files and downloads

- Since 2025-05-08, anonymous downloads from `raw.githubusercontent.com` have tighter limits; the numbers are not published, and the response is `429`.
- For scripted reads, prefer the contents API with the raw media type. It costs one `core` request, and `etag` makes repeat reads free:

```bash
gh api -H "Accept: application/vnd.github.raw" /repos/OWNER/REPO/contents/PATH?ref=main
```

- Large or repeated downloads SHOULD use release assets or a CDN rather than raw URLs.

## GitHub Pages

- 100 GB per month of soft bandwidth.
- 10 builds per hour, soft. This does not apply when a custom Actions workflow builds and publishes the site.
- Sites can be rate limited with `429` and an HTML body.

## Webhooks

- During a surge, GitHub may throttle deliveries to an account. Affected deliveries have a `throttled_at` timestamp, visible through the webhook deliveries REST API.
- Subscribe only to needed events to reduce volume.

## Events and notifications APIs

- Both are built for conditional polling. A `304` response does not spend the primary budget.
- Both return `X-Poll-Interval` in seconds, typically 60. Clients MUST NOT poll faster, and the interval can grow under load.
- Events lag by 30 seconds to 6 hours and are not for real-time use. A timeline holds at most 300 events from the past 30 days.
- Notifications use `Last-Modified` and `If-Modified-Since`.

## Authentication

- Several requests with invalid credentials in a short period make GitHub reject all authentication for that user for a while, valid credentials included, with `403`.
- GitHub App installation tokens expire after one hour.
- GitHub Apps and OAuth apps may make at most 2,000 access token requests per hour. Over the limit, token creation is blocked, which can cause outages.
- OAuth apps can hold at most 10 tokens per user, app, and scope combination. Creating more revokes the oldest unused token, or else the least recently used one. Creating more than 10 tokens in an hour forces the user to re-authorize the app in the browser.
- OAuth sign-ins: after 10 sign-ins by one user within an hour, the next sign-in that hour requires re-authorization. This is separate from the token limit.

## Audit log API (GHEC)

- 1,750 queries per hour per endpoint, per user and IP address combination.
- Over the limit, the response is usually `403` or `429`. Wait before retrying.
- The `audit_log` bucket in `/rate_limit` tracks it.

## Pull request limits

These are per-repository interaction limits, set by maintainers since 2026-06-17. They are not API rate limits, but bots that open pull requests on repositories they cannot write to can hit them.

- Maintainers can cap how many open pull requests a user without write access may have. Over the cap, the user must close or merge one before opening another.
- Bypass lists exempt trusted contributors.
- Since 2026-08-06, organizations can set the cap for all repositories. Repository settings override the organization's.
- Since 2026-10-08, maintainers can choose to count drafts.
- Since 2026-10-28, contributors can be exempted by account age or by number of merged pull requests in the repository.

## Other product limits

- Private vulnerability reports have daily per-user limits on new reports since 2026-10-01. Repository admins can set a custom daily limit and an allow list.
- Accounts and organizations can hold at most 100,000 repositories.
- GitHub Models was retired on 2026-07-30. Its inference API and its rate limits no longer exist.
- GitHub Copilot has its own usage and reliability limits. They are not covered here.

## GitHub Enterprise Server

- API rate limits are disabled by default. Ask the site administrator what the instance enforces.
- Admins can enable REST and GraphQL limits per authenticated or anonymous request, secondary limits (total requests, CPU, and search CPU), git limits per repository network or user ID, and an Actions job-runs-per-minute limit.
- `ghe-config` can exempt specific users from API rate limits.
- GHES docs describe the same headers and error responses as GitHub.com.
