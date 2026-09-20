# 03 – Reduce prompt history to stock Pi semantics

Not blocking, but should land before the move so the package ships without a
persistence feature it does not own.

Companion work: the persistent, cross-session history moves to a standalone
local extension. That is a separate document at
`agent/extensions/global-history-task.md` and is handled by a different agent.
This task only covers what the Neovim editor keeps.

## Problem

`history.ts` implements persistent global prompt history: a JSON file under
`~/.pi/agent`, dedupe on write, a deferred `enablePersistence()` so session
resume does not re-write replayed entries, and a `/history-clear` command.
None of that uses anything from the extension. The editor only calls three
methods on it: `add`, `navigate`, and `resetNavigation`.

Stock Pi keeps an in-memory array per session. It calls `addToHistory` on
every submit and replays the session's user messages on resume. Nothing is
written to disk. The Neovim editor should match that exactly and leave
persistence to the standalone extension.

## Changes

1. Rewrite `history.ts` as an in-memory class with the same three operations
   the editor already uses:
   - `add(text)`: trim, skip empty, move-to-front dedupe, cap at the same
     active limit the stock editor uses.
   - `navigate(direction, currentText)`: previous/next with a draft slot for
     the text that was in the buffer when browsing began.
   - `resetNavigation()`.
   Remove the file path, `read`, `write`, `saveEntry`, `clear`,
   `enablePersistence`, and the version constant.
2. In `editor.ts` remove `enableHistoryPersistence` and `clearHistory`.
   Keep `addToHistory` since Pi calls it. Keep the history navigation branch
   in `routeKeys` and the `preserveHistoryNavigation` guard; those are what
   make the two Pi history actions work when Up and Down belong to Neovim.
3. In `index.ts` remove the shared `PromptHistory` instance, the deferred
   `enablePersistence` timer, and the `history-clear` command. Each editor
   instance owns its own in-memory history, as the stock editor does.
4. Update `README.md`: history is per session, navigated with
   `tui.editor.historyPrevious` and `tui.editor.historyNext`, which Pi leaves
   unbound by default. Show the keybindings snippet to bind them.

## Verification

- Rewrite `agent/tests/extensions/neovim-editor-history.test.ts` to cover
  add, dedupe, cap, navigation with draft restore, and reset. Drop the
  temp-directory and atomic-write assertions.
- `./scripts/check.nu` passes.
- Manually: submit two prompts, bind the two history actions, confirm
  previous/next cycle through them and that editing the buffer resets the
  cursor into history. Confirm no `prompt-history.json` is written by this
  extension.

## Files

- `history.ts`
- `editor.ts`
- `index.ts`
- `README.md`
- `agent/tests/extensions/neovim-editor-history.test.ts`
