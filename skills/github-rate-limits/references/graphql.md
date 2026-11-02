# GraphQL API limits

The GraphQL API (`POST https://api.github.com/graphql`) has its own point budget, separate from REST `core`. Authentication is required; anonymous requests are rejected.

## Primary budget (points per hour)

| Credential                                                       | Points                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| User: PAT, OAuth app token, GitHub App user token                | 5,000, shared across all of the user's credentials              |
| User, via an app owned or approved by a GHEC org they belong to  | 10,000                                                          |
| GitHub App installation, not GHEC                                | 5,000, +50 per repo over 20, +50 per org user over 20, max 12,500 |
| GitHub App installation on a GHEC org                            | 10,000                                                          |
| OAuth app client ID and secret (public data)                     | 5,000, or 10,000 if GHEC-owned                                  |
| `GITHUB_TOKEN`, per repository                                   | 1,000, or 15,000 for resources in a GHEC enterprise             |

Response headers match REST. `x-ratelimit-resource` is always `graphql`.

## Query cost

A query's cost is estimated before it runs:

1. For each connection, count the requests needed to fill it, assuming every `first` or `last` is reached. A nested connection needs one request per parent node.
2. Sum the counts, divide by 100, and round to the nearest whole number.
3. The minimum cost is 1.

Example:

```graphql
query {
  viewer {
    repositories(first: 100) {        # 1 request
      nodes {
        issues(first: 50) {           # 100 requests, one per repository
          nodes {
            labels(first: 60) {       # 5,000 requests, one per issue
              nodes { name }
            }
          }
        }
      }
    }
  }
}
```

The total is 5,101 requests, so the query costs 51 points.

Ask the API for the cost:

```graphql
query {
  rateLimit(dryRun: true) { cost nodeCount limit remaining used resetAt }
}
```

- `dryRun: true` computes the cost without running the rest of the query.
- `cost` is what this query charged or would charge.
- `nodeCount` is the maximum number of nodes the query may return.
- `resetAt` is a `DateTime` string such as `2026-11-02T17:09:10Z`. GitHub's prose says epoch seconds, but the API returns ISO 8601. The `x-ratelimit-reset` header is epoch seconds.
- The formula and the budget are subject to change.

## Node limit

Every call MUST pass schema validation:

- Every connection MUST have a `first` or `last` argument.
- `first` and `last` MUST be between 1 and 100.
- A call MUST NOT request more than 500,000 total nodes.

Nodes multiply through nesting. `repositories(first: 50) { issues(first: 10) }` is 50 + 50 × 10 = 550 nodes.

## Timeouts

- GitHub stops any request that takes more than 10 seconds and returns `502` or `504`. The message is "We couldn't respond to your request in time".
- Each timeout deducts extra points from the primary budget for the next hour. Resending the same query wastes budget. Shrink it first.
- GitHub may change the timeout window.

## Resource limits

A query that consumes too many resources is stopped and returns partial data with an error saying resource limits were exceeded. Common causes:

- Thousands of objects or deeply nested relationships in one query.
- Large `first` or `last` values on several connections at once.
- Exhaustive detail per object, such as every comment, reaction, and related issue for every repository.

To stay under, use smaller page sizes, reduce depth, filter with arguments, split large queries, and select only needed fields.

## Secondary limits

- At most 2,000 secondary points per minute for the GraphQL endpoint. A query costs 1 and a mutation costs 5, independent of the primary cost.
- At most 60 seconds of GraphQL CPU time per 60 seconds of real time, within the shared 90 second allowance.
- At most 100 concurrent requests, shared with REST.
- Content creation, at most 80 per minute and 500 per hour, includes mutations.

See `secondary-limits.md`.

## Exceeding a limit

- **Primary**: HTTP `200`, `x-ratelimit-remaining: 0`, and an `errors` entry with `"type": "RATE_LIMITED"`. Do not retry until `x-ratelimit-reset`.
- **Secondary**: HTTP `200` or `403` with a message containing "secondary rate limit". Honor `retry-after` if present. Otherwise use `x-ratelimit-reset` if remaining is 0, or wait at least 60 seconds and back off exponentially.
- HTTP status alone is not enough. Clients MUST inspect `errors` on every `200` response.

## Practical notes

- Pause at least 1 second between mutations and avoid concurrent requests.
- `gh pr list`, `gh pr view`, `gh issue list`, `gh issue view`, and `gh project` use GraphQL, so loops over them drain the 5,000-point budget. `gh api` REST calls use `core`.
- `gh api graphql --paginate` needs a query that takes `$endCursor` and selects `pageInfo { hasNextPage endCursor }`.
- Prefer webhooks to polling.
