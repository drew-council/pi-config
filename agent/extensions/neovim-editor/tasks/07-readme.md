# 07 – Rewrite the README for first-time users

The current `README.md` is accurate but written as internal documentation for
someone who already knows how the pieces fit. A first-time user needs a
different document. Replace the scaffold-generated README with the following
structure, reusing the existing content where it fits.

## Sections

1. **What it does.** One paragraph: Pi's prompt area becomes a real
   `nvim --embed` process. Neovim owns editing, modes, mappings, registers,
   undo, and rendering. Pi owns submission, application shortcuts,
   autocomplete, history, and image paste.

2. **Requirements.**
   - Neovim 0.10 or newer on `PATH` as `nvim`.
   - Your normal Neovim configuration is loaded. The extension never falls
     back to `--clean`. If Neovim fails to start, the error appears in the
     prompt area; fix your config and run `/reload`.
   - Message interception relies on `vim.ui_attach` with `ext_messages`, which
     Neovim still marks experimental. If it is unavailable the editor keeps
     working and says so once.

3. **Install.** The standard `pi install npm:<name>` block from the scaffold,
   plus the note that extensions run with full user permissions.

4. **Keys: what Pi keeps and what Neovim gets.** This is the section the
   current README lacks and the one most likely to confuse people. Cover:
   - The rule: any key that resolves to a Pi action goes to Pi, everything
     else goes to Neovim. Same as Pi's built-in editor, same keybindings file.
   - The one exception is Escape. In plain normal mode it goes to Pi (interrupt
     under defaults); in every other mode it goes to Neovim. Under defaults,
     press Escape twice from insert mode to interrupt the agent.
   - Under Pi's defaults: Enter submits, Shift+Enter inserts a newline, Ctrl+C
     clears the editor, Ctrl+D exits on an empty prompt. Users who prefer
     Enter-as-newline bind `tui.input.submit` to `ctrl+enter`, which makes
     Enter fall through to Neovim. Users who want Ctrl+C in Neovim rebind
     `app.clear`. Show the JSON snippet for both.
   - `:PiSubmit` always submits from command-line mode.
   - `:q` in Neovim exits Pi. It does not restart the embedded instance.

5. **Prompt buffer.** Name `[Pi Prompt]`, filetype markdown, scratch buffer,
   starts in insert mode. Your markdown ftplugins and autocmds apply to it.
   Opening another buffer is allowed; autocomplete pauses until the prompt
   buffer is current again, and submission always reads the prompt buffer.

6. **Extras.**
   - Mode badge in the lower border, reflecting the true Neovim mode.
   - Neovim messages and errors surface as Pi notifications because the grid
     is too short to show them natively.

7. **History.** Per-session prompt history, matching Pi's built-in editor.
   Navigated with `tui.editor.historyPrevious` and `tui.editor.historyNext`,
   which Pi leaves unbound by default. Show the keybindings snippet. Nothing
   is written to disk.

8. **Limitations.** Keep the existing list: no mouse forwarding, no multigrid
   or external popup widgets, grid height capped at Pi's terminal-relative
   maximum, one Neovim child per session.

9. **Troubleshooting.** Run `nvim --embed` by hand to reproduce startup
   errors. `/reload` restarts the child. One unexpected exit is retried
   automatically with the prompt text preserved.

10. **Development and Releasing.** Keep the scaffold's sections.

## Verification

- Someone unfamiliar with the code can read the Keys section and predict what
  Enter, Escape, and Ctrl+D do under default bindings and under the
  Ctrl+Enter remap.
- Every command and option mentioned exists in the code after tasks 01
  through 03.
