# Secondary limits

Secondary limits protect GitHub from bursts. They sit on top of primary budgets and apply to REST and GraphQL alike. A request can hit one while plenty of primary budget remains. Their status cannot be queried. GitHub can change them without notice and may enforce more for undisclosed reasons.

## Published thresholds

| Trigger                       | Threshold                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Concurrent requests           | 100, shared by REST and GraphQL                                                                 |
| Requests to a single endpoint | 900 points per minute per REST endpoint; 2,000 points per minute for GraphQL                    |
| CPU time                      | 90 seconds per 60 seconds of real time, of which at most 60 may be GraphQL                      |
| Expensive requests            | Too many compute-heavy requests in a short time; no number is published                         |
| Content creation              | 80 content-generating requests per minute and 500 per hour; some endpoints are lower            |
| OAuth access tokens           | 2,000 token requests per hour for GitHub Apps and OAuth apps                                    |

Total response time is a rough proxy for the CPU time a client consumes.

Content creation limits count actions in the web UI, REST, and GraphQL together. A script and a person working in the browser as the same user share them.

## Points

Secondary points are separate from GraphQL primary cost.

| Request                                         | Points |
| ----------------------------------------------- | ------ |
| GraphQL query without mutations                 | 1      |
| GraphQL request with mutations                  | 5      |
| Most REST `GET`, `HEAD`, `OPTIONS`              | 1      |
| Most REST `POST`, `PATCH`, `PUT`, `DELETE`      | 5      |

Some REST endpoints have unpublished costs. At 5 points per write, 900 points per minute allows at most 180 writes per minute to one endpoint. The content creation limit of 80 per minute usually binds first.

## Endpoints that trigger notifications

Endpoints that notify people carry this note in GitHub's docs: "This endpoint triggers notifications. Creating content too quickly using this endpoint may result in secondary rate limiting." They hit secondary limits sooner than other writes.

Octokit's generated list of these paths (writes only):

- `/repos/{owner}/{repo}/issues`, `.../issues/{n}/comments`, `.../issues/{n}/sub_issue`, `.../issues/{n}/sub_issues/priority`
- `/repos/{owner}/{repo}/pulls`, `.../pulls/{n}/comments`, `.../pulls/{n}/comments/{id}/replies`, `.../pulls/{n}/merge`, `.../pulls/{n}/requested_reviewers`, `.../pulls/{n}/reviews`
- `/repos/{owner}/{repo}/commits/{sha}/comments`
- `/repos/{owner}/{repo}/releases`
- `/repos/{owner}/{repo}/collaborators/{username}`
- `/orgs/{org}/invitations`, `/orgs/{org}/invitations/{id}`
- Team discussions and their comments, under `/orgs/{org}/teams/{slug}/` and `/teams/{id}/`

## Response

- REST returns `403` or `429`. GraphQL returns `200` or `403`.
- The message contains "secondary rate limit". A typical message is `You have exceeded a secondary rate limit. Please wait a few minutes before you try again.`
- `retry-after` is usually present. Octokit notes it can be blank at first.

## Required handling

1. If `retry-after` is present, wait that many seconds.
2. Else, if `x-ratelimit-remaining` is `0`, wait until `x-ratelimit-reset`.
3. Else, wait at least 60 seconds.
4. If the next attempt fails the same way, back off exponentially and give up after a fixed number of retries.

Continuing to send requests while limited may get the integration banned.

## Safe pacing

GitHub's guidance:

- Make requests serially, through a queue, not concurrently.
- Wait at least 1 second between `POST`, `PATCH`, `PUT`, and `DELETE` requests.
- Wait at least 1 second between GraphQL mutations.
- Prefer webhooks to polling.
- Do not repeat requests that keep failing. Ignoring repeated `4xx` validation errors can get an app suspended. Repeatedly requesting a missing resource can trigger a secondary limit.

`@octokit/plugin-throttling` v11 defaults are a reasonable baseline for any client:

| Group                          | Spacing                              |
| ------------------------------ | ------------------------------------ |
| All requests                   | At most 10 concurrent                |
| Writes and all GraphQL         | At least 1 s apart, 1 at a time      |
| Writes that notify people      | At least 3 s apart                   |
| `GET /search/*`                | At least 2 s apart                   |
| Token creation endpoints       | 1 at a time                          |

For bulk content creation, such as many issues or comments, stay under about 1 per 3 seconds and 500 per hour, and plan for hours-long jobs.

## Acceptable use

GitHub's Acceptable Use Policies forbid "excessive automated bulk activity" and placing "undue burden on our servers through automated means". GitHub may throttle, suspend, or limit accounts whose bandwidth use is significantly excessive compared with similar users.
