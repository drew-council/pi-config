# 04 – Keep the personal keybindings test local

Not blocking. Do this before task 06 so the move is mechanical.

## Problem

`agent/tests/extensions/neovim-editor-keybindings.test.ts` reads
`agent/keybindings.json` from this repo and asserts personal chords. It is a
guard against accidentally breaking the local setup and cannot move to the
new package. After task 02 removes the debug-handler tests, that is all the
file contains, but its `neovim-` prefix means task 06 would sweep it up.

## Changes

1. Rename the file to `local-keybindings.test.ts` so it is obviously
   repo-specific and does not match the move in task 06.
2. Assert the bindings the local workflow depends on now that task 01 makes
   the editor work under Pi defaults too:
   - `tui.input.submit` is `ctrl+enter` (Enter falls through to Neovim).
   - `app.interrupt` is `ctrl+c`.
   - `app.exit` is an empty list (no chord; `:q` exits).
   - `app.clipboard.pasteImage` is `ctrl+v`.
   Do not assert the history chords; `ctrl+up`/`ctrl+down` belong to the
   `history` extension's shortcuts.

## Verification

- `./scripts/check.nu` passes.
- `bun test ./agent/tests/extensions` shows the same total test count before
  and after the rename.

## Files

- `agent/tests/extensions/neovim-editor-keybindings.test.ts` (rename)
