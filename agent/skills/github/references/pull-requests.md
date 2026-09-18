# Pull requests

Open PRs as drafts. CODEOWNERS assigns the readability team for each file type (go, typescript, web, api, sql, infra, build), so do not pick reviewers by hand. Reviewers wait for green checks before reading.

## The description

Start from `.github/pull_request_template.md`. Its HTML comments say what each section is for; fill the sections and delete the comments. `sheer-gh pr template` prints it and `sheer-gh pr recent 3` shows how recent merged PRs read.

Never include both a link and its bare number for a PR or issue (as in `https://github.com/sheerhealth/sheer/pull/28335` and `#28335` for the same thing). GitHub renders the two identically, so the duplication reads as noise.

Beyond the template: say what the change does, not the work process, the previous attempt, or what is left out. Most merged PR bodies are under 200 words, and over 300 is rare. No em dashes, no generated-with trailer. The title is a short imperative sentence starting with a capital letter, optionally prefixed with the area as in `agentv2: scope AgentSession to an Account`.

```sh
sheer-gh pr template
sheer-gh pr check 28335        # lint against the template headings and the rules above; exits 1 on a missing heading or issue link
sheer-gh pr check body.md      # lint a file before creating the PR
gh pr create --draft --title "..." --body-file body.md
gh pr edit 28335 --body-file body.md
```

The check-linked-issue workflow fails any PR over 50 changed lines whose body mentions no issue, unless the PR carries the `debt` label.

`gh` cannot upload images. Paste them in the web editor, or reference an existing `user-attachments` URL.

## Labels that matter

`highlight`, `internal`, and `dependencies` decide which section of the auto-generated release notes a PR lands in. `debt` skips the linked-issue check. `nostale` keeps a PR out of the stale sweep.

## Reading a PR

```sh
sheer-gh pr show 28298                    # metadata, body, comments, reviews, and unresolved threads as markdown
sheer-gh pr show 28298 --all              # include resolved threads
```

Attachments in the body or any comment are downloaded to `$TMPDIR/sheer-gh/pr-<n>/` and the printed links point at the local files; read them to see screenshots. `--no-comments` and `--no-attachments` narrow the output.

## Review threads

Inline review comments live in threads, and replies must go to the thread. Thread ids (`PRRT_...`) and comment ids appear in the headings.

```sh
sheer-gh pr threads list 28298            # unresolved threads with thread ids and comment ids
sheer-gh pr threads list 28298 --all
sheer-gh pr threads show 4007805780       # one comment with its diff hunk
sheer-gh pr threads reply 4007805780 --body-file reply.md
sheer-gh pr threads resolve PRRT_kwDOIQrPQ86iNjlQ
sheer-gh pr comment 28298 --body "..."           # top-level comment
gh api repos/sheerhealth/sheer/pulls/28298/reviews --jq '.[] | "\(.user.login) \(.state): \(.body)"'
```

Replies and comments get an attribution line by default. Reply after the change is pushed, say what changed, and resolve the thread only when the reviewer's concern is met. If the fix goes to a follow-up PR, reply with its link.

## Checks

```sh
sheer-gh ci checks 28298         # check rollup
sheer-gh ci failed 28298         # failed jobs and their error lines, see ../ci/README.md
```

Commenting `/autoformat` on a PR runs the generators and formatters on the branch and pushes the result.
