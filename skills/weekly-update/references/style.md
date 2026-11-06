# Weekly Recap style

This skill lives in a public repository. Everything below is fictional, modeled on the patterns of real recaps. Keep customer names, payer names, internal system names, and real recap text out of this file.

For real phrasing, read the current doc's Last Week column and the two previous recaps at run time. Match them where they differ from this file.

## Status emoji

- 🚀 Launched: live for customers or members. GitHub alone does not prove this.
- ✅ Completed this week.
- 🚧 Rollover: started, and continuing next week.
- 🔜 New plans for the upcoming week.

An emoji sits at the start of the bullet, followed by a space. A group bullet that only names a project takes no emoji.

## Writing a bullet

- Name the outcome, not the code change.
- Keep it to one line, usually 3 to 12 words.
- Use a noun phrase or past tense: "Bulk edit for report columns", "Retired the old report backend".
- Write for a reader outside engineering. Readers include the whole company.
- Leave out PR numbers, issue numbers, names, and implementation detail.
- Report meaningful work. Leave out small one-off fixes, tooling, tests, and refactors with no visible outcome.
- Fold the PRs for one feature into one bullet. A stack can hold several features, and each gets its own bullet.
- Say what kind of change it is when the plain reading would mislead. "Faster report pages" reads as a product speedup. "Frontend rendering performance for report pages" says what it is.
- Add a result when one exists: a before and after number, a rollout state, or a date.
- Match the section's existing punctuation. Most sections omit the final period. Some use full sentences.
- Do not inflate. "Worked on" and "Continued work on" are honest for unfinished work, under 🚧.

## From activity to bullet

| GitHub activity | Bullet |
| --- | --- |
| Seven merged PRs: add the report tables, serve reports, add helpers, add the overview page, add detail pages | ✅ Weekly reports page in the admin console |
| Merged PRs: add the audit table, write changes in changesets. Issue for the audit UI still In Progress | 🚧 Change history for reports |
| Merged PR fixing a small one-off bug | Leave out |
| Merged PR swapping a model, with eval numbers in its body | ✅ Switched to Model X (eval success 89% to 95%) |
| Issue In Review with an open PR | 🚧 Support multiple sessions in the assistant |
| One stack of open PRs: stop a running turn, then name sessions | Two bullets: 🚧 Stop the assistant mid-turn, and 🚧 Automatic names for assistant sessions |
| Issue Ready, Timeframe Now, not started | 🔜 Sandbox environment rollout |
| Dependency bumps, renames, internal tooling, test-only and lint-only PRs | Leave out |

## Rollovers

Keep the wording of a Last Week bullet when its status changes, so readers can follow it across weeks.

Last Week:

```text
Machine Learning
  - Assistant
      - ✅ Upload attachments
      - 🚧 Partial tool approvals
      - 🚧 Report history
```

This Week:

```text
Machine Learning
  - Assistant
      - ✅ Partial tool approvals
      - 🚧 Report history
      - 🚧 Run the assistant in the background
```

The finished item is not repeated. The open items carry forward, and new work joins them.

## Section shapes

Follow the shape the section used last week.

Flat:

```text
Infra
  - ✅ Moved CI runners to a regional group to unblock builds
  - 🚧 Pruning the build cache so runners don't run out of storage
```

Grouped by project, with status on the children:

```text
Enterprise Experience
  - Widget API Build
      - ✅ Coverage API
      - ✅ Webhook API
      - 🔜 Reports API
  - Acme Health
      - 🚧 Connection testing ahead of the Phase 3 launch
      - 🔜 Phase 3 launch, 11/3 tentative date
  - New Clinic Launches
      - ✅ Northside training and formal launch
      - 🚧 Lakeview pilot
```

A status parent with children, when the parts finish at different times:

```text
Member Experience
  - ✅ Faster connection screen with quicker search
  - 🚧 Name cleanup and merging:
      - ✅ First round of merge identification
      - 🚧 Merge confirmation and implementation
```

Result and rollout notes go in parentheses or after a comma:

```text
  - ✅ New report groupings (rolled out to one clinic, full rollout pending)
  - ✅ Northside launched 10/5, after customer training
```
