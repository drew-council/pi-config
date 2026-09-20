# 02 – Gate the debug-handler release on an actual binding

**Blocking for factor-out.**

## Problem

Pi's TUI intercepts Shift+Ctrl+D before any focused component sees it and
calls `tui.onDebug`, which Pi wires to its debug command. The local
`agent/keybindings.json` binds `app.exit` to `ctrl+shift+d`, so the editor
constructor calls `releaseGlobalDebugHandler(tui)` unconditionally to let the
chord through.

For any other user this silently removes Pi's debug command for as long as the
editor is mounted. It exists only because of one personal keybinding.

## Changes

Pick one:

**Option A (preferred): gate it.** In the `NeovimEditor` constructor, only
release the handler when some resolved Pi binding actually uses
`shift+ctrl+d`. After task 01 the editor has an effective-bindings lookup;
iterate the actions it handles and check whether any resolved key matches that
chord. If none do, leave `tui.onDebug` alone and skip the restore on dispose.

**Option B: drop it.** Remove `debug-key.ts`, its two call sites, and its
tests, then rebind `app.exit` locally to something Pi does not reserve. This
loses nothing for other users but changes a local habit.

Either way, update the comment in the constructor so it no longer reads as if
the release is a general requirement.

## Verification

- Existing tests in `neovim-editor-keybindings.test.ts` for
  `releaseGlobalDebugHandler` still pass if Option A is chosen.
- Add a test: with an empty user config, constructing the editor leaves
  `tui.onDebug` untouched. With `app.exit` bound to `ctrl+shift+d`, it is
  released and restored on dispose.
- Manually confirm Ctrl+Shift+D still exits Pi with the local keybindings.

## Files

- `editor.ts` (constructor, `dispose`)
- `debug-key.ts`
- `agent/tests/extensions/neovim-editor-keybindings.test.ts`
