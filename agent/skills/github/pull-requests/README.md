# Pull requests

Open PRs as drafts. CODEOWNERS assigns the readability team for each file type (go, typescript, web, api, sql, infra, build), so do not pick reviewers by hand. Reviewers wait for green checks before reading.

## The description

Start from `.github/pull_request_template.md`. Its HTML comments say what each section is for; fill the sections and delete the comments. `pr-body.sh template` prints it and `pr-body.sh recent 3` shows how recent merged PRs read.

Beyond the template: say what the change does, not the work process, the previous attempt, or what is left out. Most merged PR bodies are under 200 words, and over 300 is rare. No em dashes, no generated-with trailer. The title is a short imperative sentence starting with a capital letter, optionally prefixed with the area as in `agentv2: scope AgentSession to an Account`.

```sh
pr-body.sh template
pr-body.sh check 28335        # lint against the template headings and the rules above; exits 1 on a missing heading or issue link
pr-body.sh check body.md      # lint a file before creating the PR
gh pr create --draft --title "..." --body-file body.md
gh pr edit 28335 --body-file body.md
```

The check-linked-issue workflow fails any PR over 50 changed lines whose body mentions no issue, unless the PR carries the `debt` label.

`gh` cannot upload images. Paste them in the web editor, or reference an existing `user-attachments` URL.

## Labels that matter

`highlight`, `internal`, and `dependencies` decide which section of the auto-generated release notes a PR lands in. `debt` skips the linked-issue check. `nostale` keeps a PR out of the stale sweep.

## Review threads

`gh pr view --comments` shows only the top-level conversation. Inline review comments live in threads, and replies must go to the thread.

```sh
review-threads.sh list 28298            # unresolved threads with thread ids and comment ids
review-threads.sh list 28298 --all
review-threads.sh show 4007805780       # one comment with its diff hunk
review-threads.sh reply 4007805780 --body-file reply.md
review-threads.sh resolve PRRT_kwDOIQrPQ86iNjlQ
review-threads.sh comment 28298 --body "..."   # top-level comment
gh api repos/sheerhealth/sheer/pulls/28298/reviews --jq '.[] | "\(.user.login) \(.state): \(.body)"'
```

Replies and comments get an attribution line by default. Reply after the change is pushed, say what changed, and resolve the thread only when the reviewer's concern is met. If the fix goes to a follow-up PR, reply with its link.

## Checks

```sh
ci.sh checks 28298         # check rollup
ci.sh failed 28298         # failed jobs and their error lines, see ../ci/README.md
```

Commenting `/autoformat` on a PR runs the generators and formatters on the branch and pushes the result.
