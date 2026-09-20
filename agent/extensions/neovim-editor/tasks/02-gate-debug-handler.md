# 02 – Drop the debug-handler release

**Blocking for factor-out.**

## Problem

Pi's TUI intercepts Shift+Ctrl+D before any focused component sees it and
calls `tui.onDebug`, which Pi wires to its debug command. The local
`agent/keybindings.json` binds `app.exit` to `ctrl+shift+d`, so the editor
constructor calls `releaseGlobalDebugHandler(tui)` unconditionally to let the
chord through.

For any other user this silently removes Pi's debug command for as long as the
editor is mounted. It exists only because of one personal keybinding.

## Decision

Remove it. `:q` from Neovim already exits Pi and is the preferred way
locally, so no exit chord is needed at all.

## Changes

1. Delete `debug-key.ts`.
2. In `editor.ts` remove the `restoreDebugHandler` field, the constructor
   call, the `dispose` call, and the comment explaining the release.
3. In `agent/keybindings.json` set `"app.exit": []`. Deleting the line would
   restore Pi's default `ctrl+d`, which is a Neovim key. An empty list keeps
   exit unbound; `:q` remains the exit path.
4. Remove the two `releaseGlobalDebugHandler` tests from
   `agent/tests/extensions/neovim-editor-keybindings.test.ts` and update the
   `app.exit` assertion there to expect an empty list (task 04 handles the
   rest of that file).

## Verification

- `./scripts/check.nu` passes.
- Start Pi with the Neovim editor, press Ctrl+Shift+D, confirm Pi's debug
  command runs. Type `:q`, confirm Pi exits.
- `git grep -n onDebug agent/extensions/neovim-editor` returns nothing.

## Files

- `editor.ts`
- `debug-key.ts` (delete)
- `agent/keybindings.json`
- `agent/tests/extensions/neovim-editor-keybindings.test.ts`
