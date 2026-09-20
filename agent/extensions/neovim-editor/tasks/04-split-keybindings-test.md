# 04 – Split the keybindings test into portable and personal parts

Not blocking. Do this before task 06 so the move is mechanical.

## Problem

`agent/tests/extensions/neovim-editor-keybindings.test.ts` contains two kinds
of tests:

- One that reads `agent/keybindings.json` from this repo and asserts the
  personal chords (`app.exit` is `ctrl+shift+d`, `app.clipboard.pasteImage` is
  `ctrl+v`). This is a guard against accidentally breaking the local setup and
  belongs in this repo only.
- Two that exercise `releaseGlobalDebugHandler` in isolation. These are
  portable and belong with the extension.

If task 02 chose Option B (remove the debug handler), the portable tests go
away and only the personal one remains.

## Changes

1. Move the `releaseGlobalDebugHandler` tests into a new file, for example
   `neovim-editor-debug-key.test.ts`, alongside the other portable
   extension tests.
2. Leave the `keybindings.json` assertion where it is, but rename the file to
   make its scope obvious, for example `local-keybindings.test.ts`, and drop
   the `neovim-` prefix so it is not swept up by the move in task 06.
3. Extend the personal test to assert whichever bindings the Neovim editor
   depends on for the local workflow (submit on `ctrl+enter`), since after
   task 01 those are no longer the only way the editor works but are still
   the way this machine is configured. Do not assert the history chords; the
   global-history task moves `ctrl+up`/`ctrl+down` to extension shortcuts.

## Verification

- `./scripts/check.nu` passes.
- `bun test ./agent/tests/extensions` shows the same total test count before
  and after the split.

## Files

- `agent/tests/extensions/neovim-editor-keybindings.test.ts` (split)
