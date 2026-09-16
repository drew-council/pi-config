# CI

GitHub Actions runs on every PR and push to `main`. Production deploys run in Google Cloud Build, not here; see the releases README.

## Workflows

- `ci` has the jobs that gate a merge: `test-integration` (Bazel tests with the emulators), `test-format`, `lint-ts`, `test-migration`, and `build-ts` per frontend project.
- `Check Linked Issue` fails PRs over 50 changed lines with no issue in the body, unless labeled `debt`.
- `autoformat` runs when someone comments `/autoformat` on a PR. It regenerates, formats, lints with fixes, and pushes to the branch.
- `set sprint on issue open, close, and reopen` stamps the Sprint field on the board.
- `stale` marks PRs stale after 90 days and issues `backlog`.
- `gchat release` announces published releases.

## Discovering runs

Use `ci.sh` for discovery even when the request does not include a PR number or run ID. A workflow filter may be its name (`ci`, `autoformat`), numeric ID, or YAML file name.

```sh
ci.sh list                         # 20 most recent runs across workflows
ci.sh list autoformat --limit 10   # recent runs for one workflow
ci.sh latest autoformat            # most recent non-skipped run for one workflow
ci.sh latest ci                    # most recent non-skipped run of the main CI workflow
```

`list` includes skipped runs. `latest` ignores them because conditional workflows can create a skipped run for an event that did not actually invoke any jobs.

`autoformat` is the workflow triggered by a `/autoformat` PR comment. Formatting verification is the `test-format` job in the `ci` workflow. If a request says only "the formatting action," inspect both with `ci.sh list autoformat` and `ci.sh list ci`; do not switch to raw `gh run list`.

## Inspecting runs and failures

Full logs are large. Start with `failed`, then widen to a complete run or job log only if needed. Unlike `failed`, `log` works for successful jobs and steps too.

```sh
ci.sh checks 28298                 # check rollup for the PR
ci.sh runs 28298                   # runs on the PR head with run ids
ci.sh jobs 34982382996             # all jobs, their results, names, and ids
ci.sh failed 28298                 # failed jobs, failed steps, and error lines from their logs
ci.sh failed 34982382996           # same, by run id
ci.sh log 34982382996              # complete log for every job in the run
ci.sh log 34982382996 test-format  # complete log for this job, even if it succeeded
ci.sh rerun 34982382996 --failed
ci.sh watch 34982382996            # block until done, then print per-job results
```

Job names and IDs appear in `ci.sh jobs` output. Use `ci.sh log <run-id> <job-name>` for job logs rather than calling the Actions jobs API directly.

Bazel failures show as `FAILED TO BUILD` or `FAILED in Ns` lines naming the target. Rerun that target locally with `bazel test //path:target` before pushing a fix. A remote-cache error like `lost inputs with digests` is infrastructure, not the change; rerun the failed jobs.
