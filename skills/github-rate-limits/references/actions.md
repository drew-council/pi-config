# GitHub Actions limits

Limits that automation in or around Actions commonly hits. Unless noted, reaching a limit cancels the workflow or job. GitHub Support can raise some of them.

## API budget inside workflows

| Credential                  | REST                                               | GraphQL points                    |
| --------------------------- | -------------------------------------------------- | --------------------------------- |
| `GITHUB_TOKEN`              | 1,000/hr per repository; 15,000 for GHEC resources | 1,000/hr; 15,000 for GHEC         |
| PAT stored as a secret      | The owning user's 5,000/hr, shared with everything else that user runs | 5,000/hr |
| GitHub App installation token | 5,000 to 12,500/hr; 15,000 on GHEC              | Same; 10,000 on GHEC              |

- Every job in a repository shares that repository's `GITHUB_TOKEN` budget. Large matrices that call the API can exhaust it.
- Secondary limits apply to all three and cannot be raised on GHEC.
- Anonymous requests are keyed on the runner's IP address, which comes from a shared pool, so the 60 per hour anonymous budget may already be spent. Workflows MUST authenticate API calls, `gh` calls, and tool downloads from GitHub (for example `setup-*` actions fetching releases).

## Workflow and job limits

| Limit                                | Threshold                                                  | Raisable |
| ------------------------------------ | ---------------------------------------------------------- | -------- |
| Workflow trigger events              | 1,500 events per 10 seconds per repository                 | Yes      |
| Workflow runs queued                 | 500 runs per 10 seconds; excess runs are not queued        | No       |
| Concurrency group queue (`queue: max`) | 100 pending jobs or runs per group; more are rejected    | No       |
| Re-runs                              | 50 per workflow run, full or partial                       | Yes      |
| Matrix size                          | 256 jobs per workflow run                                  | No       |
| Workflow run time                    | 35 days, including waiting and approvals                   | No       |
| Environment approval wait            | 30 days                                                    | No       |
| Workflow file size                   | 500 KB; larger files do not start runs                     | No       |
| Check runs per check suite           | 50,000                                                     | Yes      |
| Job time, GitHub-hosted              | 6 hours                                                    | No       |
| Job time, self-hosted                | 5 days                                                     | No       |
| Queue time, self-hosted              | 24 hours, then the job is cancelled                        | No       |

A run with 30 reusable workflows counts as one run toward the queued-runs limit.

## Concurrent jobs on GitHub-hosted runners

| Runner   | Plan       | Total | macOS | GPU |
| -------- | ---------- | ----- | ----- | --- |
| Standard | Free       | 20    | 5     | n/a |
| Standard | Pro        | 40    | 5     | n/a |
| Standard | Team       | 60    | 5     | n/a |
| Standard | Enterprise | 500   | 50    | n/a |
| Larger   | Team       | 1,000 | 5     | 100 |
| Larger   | Enterprise | 1,000 | 50    | 100 |

The macOS limit is shared between standard and larger runners. Support can raise these.

## Self-hosted runners

- Registrations: 1,500 runners per 5 minutes per repository, organization, or enterprise. Raisable.
- At most 10,000 runners registered at once per runner group.
- The `actions_runner_registration` API bucket allows 10,000 requests per hour.

## Dependency cache

| Operation           | Limit per repository | When exceeded                                    |
| ------------------- | -------------------- | ------------------------------------------------ |
| Uploads (new entries) | 200 per minute     | Uploads fail until reset; `Retry-After` is set   |
| Downloads           | 1,500 per minute     | Downloads fail until reset; `Retry-After` is set |
| Deletes             | 400 per minute       | Deletes by key or ID fail until reset            |

- Storage is 10 GB per repository by default. It can be raised, and usage beyond 10 GB is billed.
- Entries unused for 7 days are removed. Over the size limit, GitHub evicts by oldest last access, which can cause cache thrashing.
- If a budget for cache storage is exceeded, the cache becomes read-only.
- The cache REST endpoints use `core`. REST deletes by key or ID also count toward the delete limit.

## Docker Hub pulls

- GitHub-hosted runners pulling public images are not subject to Docker Hub's rate limit.
- GitHub-hosted runners pulling private images are subject to it.
- Self-hosted runners are always subject to it.

## GitHub Enterprise Server

Admins can enable an Actions rate limit in job runs per minute (`ghe-config actions-rate-limiting.queue-runs-per-minute`). It is off by default. Runs over the limit fail with "You've exceeded the rate limit for workflow run requests. Please wait before retrying the run."
