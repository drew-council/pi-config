# Discussions

Discussions hold anything that needs a conversation before it becomes work: design specs, technical decisions, proposals, questions. `gh` has no discussion command, so `discussion.sh` wraps the GraphQL API.

## Which category

- Specs. Design documents for a project or feature. Start from `spec-template.md`, a copy of the template post in the category. Drop sections that do not apply. Issues for the work get filed once the spec settles.
- Decisions. Technical decision records, linked as go/tdr. A decision still being written carries the `draft` label. Example: "Versioning Strategy" (#875) defines the CalVer release tags.
- Ideas. Proposals and feature ideas that are not yet specced. Most agent-relevant threads land here.
- Q&A. Questions with an accepted answer.
- Postmortem and Retrospectives. Incident write-ups and team retros.
- Announcements, Learning, Show and tell, Polls, General. As named.

## Discussion, issue, or wiki

Use a discussion when the outcome is not yet decided or the point is to collect opinions. Use an issue when the work is defined and someone will do it. Use the wiki for how-to content that stays true after the conversation ends.

## Commands

```sh
discussion.sh categories
discussion.sh list --category Specs --limit 20
discussion.sh search agentic BVR --category Specs    # full-text over title and body
discussion.sh show 28137                             # body and comments as markdown
discussion.sh show 28137 --no-comments
discussion.sh new --category Specs --title "..." --body-file spec.md
```

The API does not apply a category's template, so for a spec copy `spec-template.md`, drop the source comment at the top, fill every section, and delete the note blocks. Creating a discussion is visible to the whole team, so confirm with the user first.
