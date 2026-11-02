# Detecting and handling rate limits

## Classify a response

Check in this order:

1. **GraphQL `200`**: inspect `errors`. An entry with `"type": "RATE_LIMITED"` is the primary limit. A message containing "secondary rate limit" is a secondary limit. Anything else is a normal GraphQL error.
2. **`429`**: always a rate limit.
3. **`403`**: a rate limit only if `x-ratelimit-remaining` is `0`, `retry-after` is present, or the message contains "rate limit". Otherwise it is a permission or policy error and MUST NOT be retried.
4. **GraphQL `502` or `504`**: a timeout. It costs extra points next hour. Shrink the query before trying again.
5. **`403` after several bad credentials**: GitHub temporarily rejects all authentication for that user, valid credentials included. Fix the credentials; do not loop.

Also note: a `404` on a private resource can mean the token lacks access. GitHub hides private resources this way. Repeatedly requesting a missing resource wastes budget and can trigger a secondary limit.

## Compute the wait

1. `retry-after` present: wait that many seconds.
2. `x-ratelimit-remaining` is `0`: wait until `x-ratelimit-reset` (UTC epoch seconds) plus 1 second.
3. Otherwise: wait at least 60 seconds, doubling on each consecutive failure.
4. Give up after a fixed number of retries and surface the error.

For a primary limit, the reset can be up to an hour away. Long-running jobs SHOULD sleep until the reset. Interactive tools SHOULD fail fast and report the reset time.

## Proactive pacing

- Read `x-ratelimit-remaining` and `x-ratelimit-reset` from every response. When remaining is low, spread the remaining requests over the time until reset.
- Keep a margin. Other tools that use the same user, such as `gh`, editors, and CI, draw from the same budget, and the count can vary between regions.
- Serialize writes with at least 1 second between them, or 3 seconds for writes that notify people.

## `gh` CLI

- `gh` never retries or waits on rate limits. A limited request exits non-zero and prints the API message with the HTTP status.
- `gh api rate_limit` shows all buckets and does not spend primary budget.
- `gh api --include` prints the status line and the `x-ratelimit-*` headers.
- `gh api --cache 1h` serves repeat identical requests from a local cache without hitting the API.
- `gh api --paginate` fetches pages sequentially; each page is one request. Add `per_page=100`.
- `gh pr`, `gh issue`, and `gh project` use GraphQL points. `gh api`, `gh run`, `gh workflow`, and `gh search` use REST buckets.
- `GH_TOKEN` or `GITHUB_TOKEN` selects the credential. In Actions, `GITHUB_TOKEN` has 1,000 requests per hour per repository.

```bash
gh api rate_limit --jq '.resources | to_entries[] | "\(.key) \(.value.remaining)/\(.value.limit) resets \(.value.reset | todate)"'
gh api --include --silent /user 2>&1 | grep -i '^x-ratelimit'
```

## Octokit (JavaScript and TypeScript)

The `octokit` package bundles `@octokit/plugin-throttling` and `@octokit/plugin-retry`. With `@octokit/core`, add them yourself.

```ts
import { Octokit } from "octokit";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(`Primary limit on ${options.method} ${options.url}; retry in ${retryAfter}s`);
      return retryCount < 1; // true retries once after the reset
    },
    onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(`Secondary limit on ${options.method} ${options.url}; retry in ${retryAfter}s`);
      return retryCount < 3;
    },
  },
});
```

Throttling plugin behavior (v11):

- Both handlers are required. A handler that returns `true` retries after `retryAfter` seconds.
- Secondary limits are detected by a `403` or `429` whose message matches `/\bsecondary rate\b/i`. If `retry-after` is missing, the plugin waits 60 seconds.
- Primary limits are detected by `x-ratelimit-remaining: 0` or a GraphQL `RATE_LIMITED` error. The wait runs until `x-ratelimit-reset` plus 1 second.
- The plugin also spaces requests: 10 concurrent overall, writes and GraphQL 1 second apart, notifying writes 3 seconds apart, and search 2 seconds apart.
- Pass a Redis-backed Bottleneck connection to share limits across processes.

The retry plugin covers other failures. It retries 3 times by default and never retries `400`, `401`, `403`, `404`, `410`, `422`, or `451`.

## `fetch` sample (Bun or Node)

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches a GitHub API URL, waiting out rate limits as GitHub's docs require. */
export async function githubFetch(url: string, init: RequestInit = {}, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    const wait = await rateLimitWait(res, attempt);
    if (wait === undefined) return res;
    if (attempt >= maxRetries) throw new Error(`GitHub rate limit persisted after ${attempt} retries: ${url}`);
    await sleep(wait);
  }
}

/** Milliseconds to wait before retrying, or undefined if the response is not rate limited. */
async function rateLimitWait(res: Response, attempt: number): Promise<number | undefined> {
  const graphql = new URL(res.url).pathname.endsWith("/graphql");
  const inspect = res.status === 403 || res.status === 429 || (graphql && res.status === 200);
  const body = inspect ? await res.clone().text() : "";
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limited =
    res.status === 429 ||
    (res.status === 403 && (remaining === "0" || res.headers.has("retry-after") || /rate limit/i.test(body))) ||
    (graphql && res.status === 200 && /"RATE_LIMITED"|secondary rate limit/i.test(body));
  if (!limited) return undefined;

  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  if (remaining === "0") return Math.max(Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now(), 0) + 1000;
  return 60_000 * 2 ** attempt;
}
```

## curl sample

```bash
curl -sS -D headers.txt -o body.json -H "Authorization: Bearer $GITHUB_TOKEN" -H "X-GitHub-Api-Version: 2022-11-28" https://api.github.com/repos/OWNER/REPO
grep -i '^x-ratelimit\|^retry-after' headers.txt
```

## GitHub Apps

- Installation tokens last one hour. Cache and reuse them. Minting one per request burns the 2,000 per hour token limit and adds latency.
- An installation's budget scales with repositories and users. See `primary-limits.md`.
- To find which integration is draining a budget in an enterprise, stream the audit log, which records API requests.
