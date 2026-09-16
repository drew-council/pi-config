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

Use `sheer-gh ci` for discovery even when the request does not include a PR number or run ID. A workflow filter may be its name (`ci`, `autoformat`), numeric ID, or YAML file name.

```sh
sheer-gh ci list                         # 20 most recent runs across workflows
sheer-gh ci list autoformat --limit 10   # recent runs for one workflow
sheer-gh ci latest autoformat            # most recent non-skipped run for one workflow
sheer-gh ci latest ci                    # most recent non-skipped run of the main CI workflow
```

`list` includes skipped runs. `latest` ignores them because conditional workflows can create a skipped run for an event that did not actually invoke any jobs.

`autoformat` is the workflow triggered by a `/autoformat` PR comment. Formatting verification is the `test-format` job in the `ci` workflow. If a request says only "the formatting action," inspect both with `sheer-gh ci list autoformat` and `sheer-gh ci list ci`; do not switch to raw `gh run list`.

## Inspecting runs and failures

Full logs are large. Start with `failed`, then widen to a complete run or job log only if needed. Unlike `failed`, `log` works for successful jobs and steps too.

```sh
sheer-gh ci checks 28298                 # check rollup for the PR
sheer-gh ci runs 28298                   # runs on the PR head with run ids
sheer-gh ci jobs 34982382996             # all jobs, their results, names, and ids
sheer-gh ci failed 28298                 # failed jobs, failed steps, and error lines from their logs
sheer-gh ci failed 34982382996           # same, by run id
sheer-gh ci log 34982382996              # complete log for every job in the run
sheer-gh ci log 34982382996 test-format  # complete log for this job, even if it succeeded
sheer-gh ci rerun 34982382996 --failed
sheer-gh ci watch 34982382996            # block until done, then print per-job results
```

Job names and IDs appear in `sheer-gh ci jobs` output. Use `sheer-gh ci log <run-id> <job-name>` for job logs rather than calling the Actions jobs API directly.

Bazel failures show as `FAILED TO BUILD` or `FAILED in Ns` lines naming the target. Rerun that target locally with `bazel test //path:target` before pushing a fix. A remote-cache error like `lost inputs with digests` is infrastructure, not the change; rerun the failed jobs.
