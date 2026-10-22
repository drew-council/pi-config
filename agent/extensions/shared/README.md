# Shared extension infrastructure

This directory contains narrow, behavior-independent helpers used by multiple repository-owned extensions.

**Do not add `index.ts`.** Pi auto-discovers `agent/extensions/*/index.ts` as extension entrypoints. Shared modules must have descriptive filenames and be imported explicitly.

A helper belongs here only when it has multiple real consumers and a stable contract independent of a domain workflow. Workflow state machines, UI, error wording, and configuration policy remain in the owning extension. Vendored extensions and externally managed files must not depend on repository-local shared helpers.

Current contracts:

- `tool-activation.ts` updates the global active-tool list while preserving unrelated tools and provides idempotent lazy registration. Removal wins an add/remove conflict.
- `session-entries.ts` finds the latest matching custom-entry data. Callers remain responsible for choosing session-wide `getEntries()` or branch-local `getBranch()` semantics.
- `paths.ts` strips one leading `@`, expands `~`, and resolves paths against a caller-supplied working directory. Command parsing such as trimming or quote removal stays with the caller.
- `clipboard.ts` reads clipboard text through platform CLI tools (`pbpaste`, `wl-paste`/`xclip`/`xsel`, PowerShell, Termux) via a caller-supplied runner such as `pi.exec`, and reports which clipboard was read. Pi exports `copyToClipboard` but not a text reader, which is why this exists. Callers decide what to do with the text and how to surface failures.
- `time.ts` formats millisecond durations (`45s`, `42m 13s`, `1h 14m 17s`) and 12-hour local clock times (`11:14 AM`) with ASCII whitespace normalization.
