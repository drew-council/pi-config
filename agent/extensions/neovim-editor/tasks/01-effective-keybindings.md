# 01 – Resolve keybindings against Pi's effective config

**Blocking for factor-out.**

## Problem

`explicitMatches` in `editor.ts` reads `keybindings.getUserBindings()`, so an
action only fires when the user has written it into their keybindings file.
Pi's defaults are ignored entirely.

The local `agent/keybindings.json` sets every action the editor checks
(`tui.input.submit` = `ctrl+enter`, `app.interrupt` = `ctrl+c`, and so on),
which is why this works here. For a user with no keybindings file:

- Enter is forwarded to Neovim as `<CR>` (a newline in insert mode). The only
  way to submit is `:PiSubmit`.
- Ctrl+D never exits Pi.

The intent behind the user-only lookup is legitimate: Pi's default
`app.interrupt` is `escape`, and Escape must reach Neovim. Pi's default
`tui.input.submit` is `enter`, and the local workflow wants Enter to be a
newline. Those are workflow choices and should not be the default behaviour
for everyone.

## The rule

**Any key that resolves to a Pi action goes to Pi. Every other key goes to
Neovim.** No per-key special cases, with one exception described below. This
is the same rule Pi's built-in editor follows, so users can reason about the
Neovim editor with the same keybindings file and the same defaults.

Consequences under Pi defaults, which the README must spell out:

- Enter submits, Shift+Enter and Ctrl+J insert a newline.
- Ctrl+C clears the editor (`app.clear`). Users who want Neovim to see
  Ctrl+C rebind `app.clear`.
- Ctrl+D exits when the prompt is empty, otherwise reaches Neovim.
- Users who prefer Enter-as-newline bind `tui.input.submit` to `ctrl+enter`,
  which lets Enter fall through to Neovim.

## The one exception: Escape

Escape is Pi's default `app.interrupt` and also the key Neovim needs to leave
insert, visual, replace, operator-pending, and command-line mode. Route it by
mode, using `host.mode` (already synchronized from `nvim_get_mode()`):

- If Neovim is in plain normal mode, Escape is a no-op for Neovim, so hand it
  to whatever Pi action it resolves to (interrupt under defaults).
- In any other mode, send it to Neovim.

"Plain normal mode" means `nvim_get_mode().mode` is exactly `n`, not `no`
(operator pending), `niI`, and so on. `get-state.lua` already maps these to
families; extend it to expose whether a count or operator is pending if the
family alone is not enough (`vim.v.count > 0`, `vim.fn.state()`). A default
user interrupts the agent by pressing Escape twice from insert mode.

This exception applies to the Escape key itself, not to `app.interrupt`. A
user who binds interrupt to Ctrl+C gets interrupt on Ctrl+C in every mode.

## Changes

1. Replace `explicitMatches` with a lookup over effective bindings using
   `keybindings.getKeys(action)` from the `KeybindingsManager` Pi passes to
   the editor factory.
2. Add the mode-aware Escape routing described above.
3. Handle `tui.input.newLine` (Pi default `shift+enter`, `ctrl+j`) by sending
   `<CR>` to Neovim. Today the action is not checked at all, so with default
   bindings Shift+Enter would be forwarded as an unknown key.
4. Keep `app.exit` guarded on empty prompt text, matching Pi's built-in
   editor.
5. The autocomplete branch (`tui.select.*`, `tui.input.tab`) uses the same
   effective lookup. `tui.select.cancel` defaults to `escape` and `ctrl+c`;
   while the autocomplete list is open, Escape closes the list rather than
   going to Neovim, matching the built-in editor. Verify rather than assume.

## Verification

- Add a unit test that constructs a `KeybindingsManager` with an empty user
  config and asserts:
  - `\r` (Enter) routes to submit.
  - `\x04` (Ctrl+D) routes to exit when the prompt is empty and to Neovim when
    it is not.
  - `\x1b` (Escape) goes to Neovim in insert mode and to interrupt in normal
    mode.
  - Shift+Enter routes to Neovim as `<CR>`.
- Add a second test with the local `keybindings.json` shape (submit on
  `ctrl+enter`) asserting Enter reaches Neovim.
- Run the integration suite; nothing there should change.
- Manually: temporarily move `agent/keybindings.json` aside, start Pi, type a
  prompt, press Enter, confirm it submits. Press Escape twice while the agent
  runs, confirm it interrupts. Restore the file.

## Files

- `editor.ts` (`explicitMatches`, `routeKeys`, `requestAppExit`)
- `lua/get-state.lua` (if a finer mode signal is needed)
- new test under `agent/tests/extensions/`
