# Global prompt history as a standalone local extension

## Goal

Persistent, cross-session prompt history that works with any Pi editor
component, without modifying the editor. Today this lives inside
`agent/extensions/neovim-editor/history.ts`. That extension is being factored
out into a published package and should ship with stock per-session history
only (see `neovim-editor/tasks/03-stock-history.md`). The persistence feature
stays local to this config as its own extension.

Background is in `global-history-plan.md` at the repo root, which predates the
Neovim editor and proposed subclassing `CustomEditor`. That approach is no
longer needed; the hooks below are sufficient and editor-agnostic.

## Pi hooks to use

- `pi.on("input", ...)` fires on every interactive submit with `event.text`.
  Persist there. It does not fire on session resume, so replayed messages are
  never re-written, which removes the reason for the deferred
  `enablePersistence` in the current code.
- `pi.registerShortcut(key, { handler })` for previous and next. Both the
  stock editor and the Neovim editor route extension shortcuts before their
  own key handling.
- `ctx.ui.getEditorText()` and `ctx.ui.setEditorText()` to read the current
  buffer and replace it during navigation.
- `getAgentDir()` from `@earendil-works/pi-coding-agent` for the file
  location. Do not hard-code `~/.pi/agent`.

## Behaviour

- File: `<agent dir>/prompt-history.json`, same shape as today
  (`{ version, entries }`, newest first, deduped, capped). Reuse the
  normalize/read/write code from the current `history.ts`, including the
  atomic temp-file-then-rename write.
- Navigation state per session: index into entries, plus a draft holding the
  buffer text when browsing began. Track the last text the extension wrote
  into the editor. On each shortcut, if the current editor text differs from
  that, the user edited, so reset the index and take the current text as the
  new draft.
- Previous walks older, next walks newer, and stepping past the newest
  restores the draft.
- `/history-clear` command: truncate the file and reset navigation.
- Load the file once at `session_start`; keep the active window in memory.

## Keybindings

The local `agent/keybindings.json` currently binds `tui.editor.historyPrevious`
and `tui.editor.historyNext` to `ctrl+up` and `ctrl+down`. Remove those two
entries so the editor's in-session history does not compete for the chords,
and register the extension shortcuts on `ctrl+up` and `ctrl+down` instead. The
global file contains every prompt from the current session too, so nothing is
lost.

## Files

- new: `agent/extensions/global-history.ts`
- new: `agent/tests/extensions/global-history.test.ts` covering the file
  read/write/dedupe/cap logic and the navigation state machine with a fake
  editor text getter/setter
- edit: `agent/keybindings.json`
- edit or delete: `global-history-plan.md`, since it is superseded

## Verification

- `./scripts/check.nu` passes.
- With the stock editor: submit prompts in one session, start a new session,
  Ctrl+Up cycles through them, Ctrl+Down returns to the draft.
- Repeat with the Neovim editor active.
- `/history-clear` empties the file and the notification appears.
- Session resume does not duplicate entries in the file.
