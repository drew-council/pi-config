---
name: weekly-update
description: Draft and apply the invoking user's own updates to the Sheer Weekly Recap Google Doc, from their sprint issues and their past week of GitHub activity. Always presents a draft for approval before editing the doc.
disable-model-invocation: true
---

# Weekly update

Turn the user's own sprint issues and past week of GitHub activity into updates for the This Week column of the current Weekly Recap. The user approves a draft. You then do everything else.

Everyone on the team writes their own updates. This skill writes the user's, and nobody else's.

The flow is: find the doc, gather, draft, wait for approval, apply, verify, check off, report.

## Rules

- You MUST draft only the user's own work: PRs they authored and issues assigned to them. You MUST NOT draft, suggest, or list work by anyone else, even when the doc is missing it or a section is empty.
- You MUST present a draft and get explicit approval before any write to the doc. Approval covers that draft only.
- You MUST NOT ask the user to do any step by hand. After approval, the work is yours.
- You MUST NOT touch the Last Week column, the BLUF, Weekly Metrics, other tabs, or anyone else's checkbox.
- You MUST NOT change a bullet that describes a teammate's work.
- You MUST NOT claim a step worked until a read confirms it.
- You MUST NOT save recap text, customer names, or GitHub activity into this skill or the repository that holds it. That repository is public.

## Google tools

Tool names differ by agent. Claude Code has `read_doc` and `update_doc` from the Google Docs connector, and `search_files` and `read_file_content` from the Google Drive connector. Pi's `work-drive` server reads Drive but cannot write. Load deferred tools before deciding one is missing.

If this agent has no tool that writes to Google Docs, still complete the draft. Then say this agent cannot apply it, and that Claude Code can.

## 1. Find the doc

If the user gave a link or doc ID, use it. Otherwise search Drive:

```text
title contains 'Weekly Recap' and mimeType = 'application/vnd.google-apps.document'
```

Follow every next-page token. Titles end in a `YYYY-MM-DD` date. Ignore titles that start with `Copy of` or `[scratch]`. When two docs share a date, take the one modified last.

- The current doc has the latest date. If that date is more than 6 days old, this week's doc does not exist yet. Say so and stop. Creating it belongs to the recap's owner.
- The previous recap has the next latest date. Its date starts the activity window.

Read the current doc and the two previous recaps with `read_file_content`. You MUST pass `includeComments: true`. Without it, emoji come out garbled and the end is cut off.

Then read the current doc with `read_doc`. The result is too large to return inline, so it is saved to a file. Run the helper on that path:

```sh
bun {{skillDir}}/scripts/doc-edits.ts show <saved-read>
```

## 2. Gather

Read `~/work/sheer/.claude/skills/github/SKILL.md`, then its `references/issues-sprints.md` and `references/people.md`. Follow that skill's rules. Everything here is read-only.

Run these from `~/work/sheer`. `sheer-gh` is often not on `PATH` outside that repository, so call `experimental/sheer-gh/bin/sheer-gh`.

Every query is scoped to the user. Do not widen one, and do not read the whole board or the team's PRs.

```sh
gh api user --jq .login
sheer-gh sprint list
sheer-gh sprint issues --mine current
sheer-gh sprint issues --mine "<previous sprint title>"
sheer-gh issue search --state closed --limit 100 "assignee:@me closed:>=<window start>"
gh pr list --repo sheerhealth/sheer --state merged --search "author:@me merged:>=<window start>" --limit 300 --json number,title,mergedAt,labels
gh pr list --repo sheerhealth/sheer --state open --search "author:@me updated:>=<window start>" --limit 100 --json number,title,isDraft,updatedAt
```

The first command gives the user's login. Find their name for it in `references/people.md`.

Include the previous sprint when the window crosses a sprint start. `sheer-gh` has no PR listing, so `gh` is the right tool for those. The `--limit` of `issue search` is at most 100, and a higher value returns nothing.

Read a PR or issue with `sheer-gh pr show` or `sheer-gh issue show` only when it is the user's and its title does not say what shipped. Use `sheer-gh issue subs <epic>` to see how far one of the user's epics has come.

Map board state to status:

| Evidence | Status |
| --- | --- |
| PR merged or issue Done in the window | ✅ |
| Live for customers or members, confirmed by an issue, PR, or release | 🚀 |
| In Progress, In Review, or Blocked, with work this week | 🚧 |
| Ready with Timeframe Now, not started | 🔜 |
| Triage, Scoping, Parked, or no activity | Leave out |

Put each item of the user's work in the section it belongs to. Use the section's Last Week bullets, labels such as `customer/*`, `area/*`, and `proj/*`, and the epic. If a section stays unclear, list the item under Unplaced in the draft. Do not guess.

Then reconcile the user's own bullets. A Last Week 🚧 or 🔜 bullet is the user's only when it matches one of their issues or PRs. Give each of those a status from the evidence: finished or still open. Keep its wording. Skip every other bullet without mentioning it, because it belongs to a teammate.

Skip what the doc already says. The user or a teammate may already have written it, so match on meaning, not exact words.

## 3. Draft

Read `{{skillDir}}/references/style.md`, then write the draft in the voice of the real recaps you read.

Present it like this:

```markdown
Weekly Recap <date>, activity since <window start>

## <Section>
Add:
- ✅ <bullet> (#123, #124)
- 🚧 <bullet> (#125)

Change:
- 🚧 <old bullet> → ✅ <new bullet> (#126)

## Unplaced
- <item>: <why it is unclear> (#127)

Left out: <the user's own work you skipped, and why>
```

List only sections that gain or change one of the user's bullets. Do not mention other sections, or what teammates did or did not write.

PR and issue numbers appear in the draft as evidence. They MUST NOT go in the doc. Say where a nested bullet goes. Note anything you inferred.

Ask for approval or changes, then stop and wait. Do not write to the doc in the same turn as a draft. Redraft on feedback, and ask again.

## 4. Apply

Work only from the approved draft.

1. Read the doc with `read_doc` again. People edit it all day. Keep this saved read as the "before" read.
2. Write the approved changes to a JSON file outside the repository. The header of `{{skillDir}}/scripts/doc-edits.ts` documents the format. Leave out the evidence numbers.
3. Build the requests:

   ```sh
   bun {{skillDir}}/scripts/doc-edits.ts plan <before-read> <edits.json>
   ```

4. Send its `requests` and `writeControl` in one `update_doc` call. Never remove `requiredRevisionId`.

If `plan` fails because a teammate changed a bullet, compare the draft with the new text. Apply what is still correct. If the approved text no longer fits, show the difference and ask.

If `update_doc` rejects the revision, someone edited the doc. Read again, plan again, and resend.

New bullets go after the last bullet of their section or parent. Adding a nested bullet where its parent has no children rebuilds that section's list, because Docs cannot set a level any other way. Bullet text and order do not change.

## 5. Verify

Read the doc with `read_doc` again, then:

```sh
bun {{skillDir}}/scripts/doc-edits.ts verify <before-read> <after-read> <edits.json>
```

It checks that every edit landed at the right level, that no bullet was lost or changed level, and that the Last Week column did not change. A teammate's edit during the run can also show up here, so read each problem before acting on it.

Fix real problems with a new read, plan, and write. Report anything you cannot fix.

## 6. Check off the box

Do this only after verify passes, and only for the user's own name.

The Docs API cannot set a checklist box, so `update_doc` cannot do this step. Strikethrough does not tick it. `read_doc` does not show its state either. `read_file_content` does, as `- [x] [Name](mailto:...)`.

Use the T3 Code integrated browser, through its `preview_*` tools. This skill's invocation is the request for that browser work.

1. Read the doc with `read_file_content`. If the user's line already shows `[x]`, skip this step. A second click unticks the box.
2. Open the doc with `preview_open`, passing `profileId: "Work"` and `reuseExistingTab: false`. The default profile holds a personal account that cannot open the doc. Never act on a tab the user opened.
3. Take a `preview_snapshot` with `includeImage: true`. Check that the account button names the Sheer account. If the page says "You need access" or asks for a sign-in, stop and report it. You MUST NOT click "Request access", and you MUST NOT enter credentials.
4. Find the box in the image, left of the user's name under "Did you complete your updates?". Docs draws its page on a canvas, so the accessibility tree does not list it.
5. Convert the position. The image is scaled against click coordinates, so divide x and y by the image width over the width of the root `application` box. With a 1280 image and a 1241 box, image position (395, 719) is click position (383, 697).
6. Click once with `preview_act`, using `x` and `y`.
7. Read the doc with `read_file_content` again. The user's line MUST show `[x]`, and every other line MUST match step 1. If the click hit a neighbor's box, click that box again to restore it, then report what happened.
8. Close your tab with `t3_preview_close`.

If the Work profile is not signed in, or the `preview_*` tools are missing, report that the box is still unticked and why. Do not report it as done.

## 7. Report

Link the doc. Say which sections changed, whether verify passed, and whether the box is ticked. Name anything left undone.
