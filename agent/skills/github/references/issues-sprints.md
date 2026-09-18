# Issues and sprints

An issue is the unit of work. Aim for one issue per PR. The wiki page "Project Management" is the source for the process; this file is the short version plus the commands.

## Fields

An issue has a type, labels, one assignee, and board fields. Only the first two live on the issue itself.

- Type is an org-level issue type, not a label: Bug, Task, Feature, Epic, Meta, Security. The issue forms in `.github/ISSUE_TEMPLATE` set it in the browser. `gh issue create` cannot, so use `sheer-gh issue new`, which reads the type, labels, and headings from the form.
- Labels categorize: `area/*` (canopy, azalea, app, provider, backend_automation), `lang/*`, `provider/*`, `customer/*`, `proj/*`. `debt` marks tech debt and exempts a PR from the linked-issue check. `highlight` and `internal` steer release notes. `good_first_issue` and `backlog` mean what they say. Run `gh label list --limit 200` for the full set.
- One assignee. Triage requires a single owner.
- Epics group work through parent and sub-issues. `sheer-gh issue subs <epic>` lists them, `sheer-gh issue parent <issue> <epic>` attaches one.

## The board

Org project 9 "Sheer" holds the fields that are not on the issue: Status, Priority (High, Med, Low), Timeframe (Now, Next, Later), and Sprint. Status moves Triage, Scoping, Ready, In Progress, In Review, Done, with Blocked and Parked to the side.

Automation does most status moves. A PR that closes an issue moves it to In Progress, In Review, and Done as the PR progresses. Closing an issue sets Done. New issues start in Triage.

An issue is Ready when it has one assignee, a clear title, a scoped description, a type, a priority, and a timeframe.

## Sprints

A sprint is a two-week iteration on the board's Sprint field. A workflow stamps the current sprint on an issue when it is opened (if the field is empty) and again when it is closed or reopened. So a new issue lands in the current sprint by default; move it if the work is not for this sprint. The `Sprint 10` label is not the mechanism and should be ignored.

```sh
sheer-gh sprint list                       # every sprint with id and dates, current marked
sheer-gh sprint show 28136                 # Sprint, Status, Priority, Timeframe for an issue
sheer-gh sprint set 28136                  # current sprint; adds the issue to the board if needed
sheer-gh sprint set 28136 next             # or a title: "Sprint 12"
sheer-gh sprint status 28136 "In Progress"
sheer-gh sprint field 28136 Priority High
sheer-gh sprint issues current --mine      # filtered ProjectV2 query
```

Preview writes with the global flag before the group, for example `sheer-gh --dry-run sprint set 28136 next`.

## Creating an issue

Search first so you do not file a duplicate, then pick the form and write a body with its headings. `ops_request` has dropdowns and an owner; file those in the browser.

```sh
gh issue list --search "emulator slow" --state all
sheer-gh issue templates                   # forms with the type and labels each applies
sheer-gh issue template bug                # headings for the body
sheer-gh issue new --template bug --title "Spanner emulator schema apply makes tests slow" \
  --body-file body.md --assignee @me --label area/backend_automation
sheer-gh issue new --template chore --title "..." --body-file body.md --parent 26835 --sprint next
```

Write the problem, not the implementation. A bug report says what was observed and how to reproduce it. A task says what needs to be done and how to know it is done. Leave design to the PR or a discussion.

## Reading an issue

```sh
sheer-gh issue show 28136                  # metadata, board fields, body, and comments as markdown
sheer-gh issue show 28136 --no-comments
sheer-gh issue subs 26835                  # sub-issues of an epic with state
```

`show` downloads attachments (GitHub uploads and `console.cloud.google.com`, `storage.cloud.google.com`, or `storage.googleapis.com` links) into `$TMPDIR/sheer-gh/issue-<n>/`, rewrites the links in the printed markdown to those paths, and saves the markdown there too. Read the image files to see the screenshots. `--no-attachments` skips the downloads.
