# Persistent prompt history

Cross-session prompt history for any Pi editor component, including the stock
editor and the embedded Neovim editor. The extension never touches the editor
itself. It reads and writes the prompt buffer through `ctx.ui.getEditorText`
and `ctx.ui.setEditorText`.

## Storage

Entries live in `<agent dir>/prompt-history.json` as `{ version, entries }`,
newest first, de-duplicated, capped at 1000 on disk and 100 in memory. Writes
go to a temporary file and are renamed into place, and every write re-reads the
file first so parallel sessions merge instead of overwriting each other. A
failed write never blocks submission.

`pi.on("input")` fires only on real submissions, so resuming a session replays
messages without rewriting entries.

## Keys

`ctrl+up` and `ctrl+down` by default, overridable through
`extension.historyPrevious` and `extension.historyNext` in
`agent/keybindings.json`. Previous walks toward older entries, next walks back,
and stepping past the newest restores the draft that was in the buffer when
browsing began. Editing the buffer mid-browse makes that text the new draft.

Leave `tui.editor.historyPrevious` and `tui.editor.historyNext` unbound on
those chords. The editor's own per-session history would otherwise compete for
them.

## Commands

`/history-clear` empties the file and resets navigation.
