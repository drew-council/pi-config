# Changes and sources

## Dated changes since 2025

| Date       | Change                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 2025-05-08 | Tighter limits for anonymous requests: HTTPS clones, REST calls, and `raw.githubusercontent.com` downloads. No numbers published. |
| 2026-01-16 | Actions cache uploads limited to 200 new entries per minute per repository. Docs now also list 1,500 downloads and 400 deletes per minute. |
| 2026-03-10 | REST API version `2026-03-10` removes the deprecated top-level `rate` object from `GET /rate_limit`. Unversioned requests still get `2022-11-28`. |
| 2026-04-10 | Actions workflow runs limited to 50 re-runs.                                                             |
| 2026-05-07 | Actions concurrency groups can queue up to 100 pending runs with `queue: max`.                           |
| 2026-05-19 | `code_scanning_upload` removed from `GET /rate_limit`. SARIF uploads count against `core`.               |
| 2026-06-17 | Repositories can cap open pull requests for users without write access.                                  |
| 2026-07-30 | GitHub Models retired, along with its inference API limits.                                               |
| 2026-08-06 | Pull request limits can be set at the organization level.                                                |
| 2026-10-01 | Private vulnerability reports get daily per-user limits.                                                 |
| 2026-10-08 | Pull request limits can count drafts.                                                                    |
| 2026-10-28 | Pull request limits can exempt contributors by account age or merge history.                             |

Undated documentation changes in effect on 2026-11-02:

- Higher-limit apps acting for a user drain that user's budget for lower-limit credentials.
- `x-ratelimit-*` headers are authoritative over `GET /rate_limit`, and values vary by region.
- `GET /search/issues` gained `search_type=semantic|hybrid`, limited to 10 requests per minute.

## Refreshing this skill

GitHub Docs serves any article as Markdown:

```bash
curl -sS 'https://docs.github.com/api/article/body?pathname=/en/rest/using-the-rest-api/rate-limits-for-the-rest-api'
```

Recheck the GitHub Docs pages below. Also run `gh api rate_limit` to see the current buckets, and search the changelog for "rate limit".

## Sources

GitHub Docs:

- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
- https://docs.github.com/en/rest/rate-limit/rate-limit
- https://docs.github.com/en/rest/search/search
- https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
- https://docs.github.com/en/rest/activity/events
- https://docs.github.com/en/rest/activity/notifications
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- https://docs.github.com/en/graphql/reference/meta
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/rate-limits-for-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/actions/reference/limits
- https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks
- https://docs.github.com/en/get-started/using-github/troubleshooting-connectivity-problems
- https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/using-the-audit-log-api-for-your-enterprise
- https://docs.github.com/en/enterprise-server@latest/admin/configuring-settings/configuring-user-applications-for-your-enterprise/configuring-rate-limits

GitHub Changelog:

- https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/
- https://github.blog/changelog/2026-01-16-rate-limiting-for-actions-cache-entries/
- https://github.blog/changelog/2026-04-10-actions-workflows-are-limited-to-50-reruns/
- https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/
- https://github.blog/changelog/2026-05-19-removal-of-code_scanning_upload-field-from-rate_limit-api-endpoint/
- https://github.blog/changelog/2026-06-17-limit-open-pull-requests-for-users-without-write-access/
- https://github.blog/changelog/2026-08-06-set-pull-request-limits-at-the-organization-level/
- https://github.blog/changelog/2026-10-01-rate-limits-for-private-vulnerability-reports/
- https://github.blog/changelog/2026-10-08-draft-pull-requests-count-toward-pull-request-limits/
- https://github.blog/changelog/2026-10-28-pull-request-limits-exempt-contributors-by-age-or-history/

Client libraries:

- https://github.com/octokit/plugin-throttling.js (v11.0.5)
- https://github.com/octokit/plugin-retry.js

Live checks on 2026-11-02 with `gh` 2.102.0: `GET /rate_limit` buckets and windows, `x-github-api-version-selected: 2022-11-28` on unversioned requests, the `rateLimit.resetAt` format, and the rejection of anonymous GraphQL requests.
