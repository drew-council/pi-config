# 03b – Move `:pb` out of the extension into the Neovim config

Not blocking, but should land before the move so the package ships without a
personal command.

## Problem

`lua/setup.lua` defines a buffer-local `:Pb [lang]` command on `[Pi Prompt]`
that wraps the clipboard in a fenced code block, plus a `cnoreabbrev pb Pb`
so it can be typed as `:pb`. It is a personal workflow helper, and nothing
about it needs the Pi buffer: wrapping the clipboard in a fence is useful in
any Markdown buffer.

## Changes

### Extension

1. Remove the `Pb` user command, its helper code, and the `cnoreabbrev` from
   `lua/setup.lua`.
2. Remove the `:pb` mention from `README.md` (task 07 rewrites the README
   anyway; make sure it does not reappear).

No replacement hook is needed. The prompt buffer has filetype `markdown`, so
anything the user's config attaches to Markdown buffers applies to it. The
`TextChanged`, `CursorMoved`, and `ModeChanged` autocmds in `setup.lua`
already notify Pi after a command edits the buffer, and `get-state.lua`
re-normalizes the viewport on every synchronization, so a config-side command
does not need to call `pi_state_dirty` or `pi_normalize_prompt_viewport`.

### Neovim config (`~/nixconf/nixvim.nix`, `extraConfigLua`)

3. Add a `FileType markdown` autocmd that creates the buffer-local `Pb`
   command with the same behaviour as today (read `+`, fall back to `*`, warn
   on empty, strip trailing blank lines, insert `""`, ```` ```lang ````,
   body, ```` ``` ````, `""` below the cursor line, move the cursor to the
   blank line after the block).
4. Add the `cnoreabbrev pb Pb` globally, or restrict it with
   `<expr>` to command-line mode when the current buffer is Markdown.
5. Rebuild home-manager and confirm `init.lua` picks it up.

## Verification

- In the embedded prompt: copy some text, type `:pb lua`, confirm the fenced
  block appears, the cursor lands below it, and Pi's mirrored state matches
  (submit and check the message).
- In a regular `nvim` on a `.md` file: `:pb` works the same way.
- In a non-Markdown buffer: `:Pb` is not defined.
- Integration tests still pass (none reference `Pb`).

## Files

- `lua/setup.lua`
- `README.md`
- `~/nixconf/nixvim.nix` (outside this repo)
