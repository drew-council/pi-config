# 01 – Resolve keybindings against Pi's effective config

**Blocking for factor-out.**

## Problem

`explicitMatches` in `editor.ts` reads `keybindings.getUserBindings()`, so an
action only fires when the user has written it into their keybindings file.
Pi's defaults are ignored entirely.

The local `agent/keybindings.json` sets every action the editor checks
(`tui.input.submit` = `ctrl+enter`, `app.exit` = `ctrl+shift+d`, history on
`ctrl+up`/`ctrl+down`, and so on), which is why this works here. For a user
with no keybindings file:

- Enter is forwarded to Neovim as `<CR>` (a newline in insert mode). The only
  way to submit is `:PiSubmit`.
- Ctrl+D never exits Pi.
- History navigation is unreachable (Pi's default for those actions is empty
  anyway, so this one is fine).

The intent behind the user-only lookup is legitimate: Pi's default
`app.interrupt` is `escape`, and Escape must reach Neovim. Pi's default
`tui.input.submit` is `enter`, and the local workflow wants Enter to be a
newline. Those are workflow choices and should not be the default behaviour
for everyone.

## Changes

1. Replace `explicitMatches` with a lookup over effective bindings using
   `keybindings.getKeys(action)` (available on `KeybindingsManager` from
   `@earendil-works/pi-tui`, re-exported through `pi-coding-agent`).
2. Add a deliberate exclusion list of keys that must always reach Neovim
   regardless of what Pi binds them to. At minimum: `escape`. Filter these out
   of the resolved key list before matching. Do this per-key, not per-action,
   so a user who rebinds `app.interrupt` to `ctrl+c` still gets interrupt.
3. Handle `tui.input.newLine` (Pi default `shift+enter`, `ctrl+j`) by sending
   `<CR>` to Neovim. Today the action is not checked at all, so with default
   bindings Shift+Enter would be forwarded as an unknown key.
4. Keep `app.exit` guarded on empty prompt text, matching Pi's built-in editor.
5. Confirm the autocomplete branch (`tui.select.*`, `tui.input.tab`) also uses
   the effective lookup; `tui.select.cancel` defaults to `escape` and `ctrl+c`,
   so with the exclusion list active the autocomplete popup needs another
   cancel path. Sending Escape to Neovim already cancels because the buffer
   state changes; verify this rather than assume it.

## Verification

- Add a unit test that constructs a `KeybindingsManager` with an empty user
  config and asserts:
  - `\r` (Enter) routes to submit.
  - `\x04` (Ctrl+D) routes to exit when the prompt is empty and to Neovim when
    it is not.
  - `\x1b` (Escape) is never claimed by Pi.
  - Shift+Enter routes to Neovim as `<CR>`.
- Add a second test with the local `keybindings.json` shape (submit on
  `ctrl+enter`) asserting Enter reaches Neovim.
- Run the integration suite; nothing there should change.
- Manually: temporarily move `agent/keybindings.json` aside, start Pi, type a
  prompt, press Enter, confirm it submits. Restore the file.

## Files

- `editor.ts` (`explicitMatches`, `routeKeys`, `requestAppExit`)
- new test under `agent/tests/extensions/`
