# Embedded Neovim prompt editor

Pi's prompt area is backed by a real `nvim --embed` process connected through a small MessagePack-RPC client. Neovim owns buffer editing, modes, mappings, registers, macros, search, command-line behavior, undo, and rendering. Pi still owns prompt submission, application actions, global prompt history, image insertion, and its autocomplete providers.

## Requirements and startup

- Neovim 0.10 or newer must be available as `nvim` on `PATH`.
- The editor intentionally loads the normal user Neovim configuration. It does not silently retry with `--clean`.
- Pi hides Neovim's redundant statusline and built-in mode row. Its command line remains available in the prompt grid, while Neovim messages—including errors—are forwarded to Pi notifications so they remain visible. The active Neovim mode appears as a badge in Pi's lower editor border.
- One Neovim child is started per interactive Pi session and stopped during `/reload` or shutdown.
- The prompt uses a scratch buffer named `[Pi Prompt]` with Markdown filetype.

If startup fails, fix the reported Neovim/configuration error and run `/reload`. `nvim --embed` can be run separately when diagnosing startup configuration. The integration retries one unexpected process exit, preserving the latest mirrored prompt.

## Submitting and editing

- `:PiSubmit` submits from Neovim command-line mode.
- Neovim `:q` exits Pi, rather than restarting the embedded Neovim process.
- Ordinary editor input is passed to Neovim unless its configured action is explicitly owned by Pi.
- Pi autocomplete remains available for slash commands, command arguments, attachments, extension trigger characters, and forced path completion. Its list is rendered below the Neovim grid.
- `Ctrl+V` uses Pi's standard clipboard handler: images are saved to Pi's temporary file and their path is inserted into the Neovim prompt; plain text falls back to normal clipboard insertion.
- Persistent prompt history continues to operate on the Neovim prompt buffer.

## History and programmatic edits

Prompt history remains in `~/.pi/agent/prompt-history.json`; `/history-clear` clears it. Pi's external editor, queued-message restoration, extension text insertion, paste-to-editor, and clipboard image paths update the native prompt buffer through Neovim APIs.

## Current limitations

- Mouse events are not forwarded because Pi's component API does not expose the prompt grid's absolute screen origin.
- Neovim optional external widgets and multigrid are disabled. The command line is rendered in Pi's final prompt-grid row; popup menus, floating windows, and plugin UI are composed by Neovim into its normal line grid. Messages are forwarded to Pi notifications so error text remains visible even when the prompt grid is short.
- Opening another Neovim buffer is allowed and displayed, but Pi autocomplete pauses until `[Pi Prompt]` is current again. Pi submission always reads the dedicated prompt buffer.
- The grid starts at one row, grows with Neovim's measured display height, and then scrolls at Pi's terminal-relative editor maximum.
