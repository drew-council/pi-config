# 06 – Move and repoint the tests

Run right after task 05, in the new repo.

## Tests to move

All of these import from `../../extensions/neovim-editor/...` and need their
paths changed to `../src/...`:

| Current file | Notes |
|---|---|
| `neovim-editor-grid.test.ts` | pure unit test, move as is |
| `neovim-editor-history.test.ts` | rewritten in task 03 as in-memory only, move as is |
| `neovim-editor-input-events.test.ts` | pure unit test, move as is |
| `neovim-editor-layout.test.ts` | pure unit test, move as is |
| `neovim-host.integration.test.ts` | spawns real `nvim --clean --embed`, see below |
| new effective-keybindings test from task 01 | move as is |

## Do not move

- `local-keybindings.test.ts` (renamed in task 04). It reads
  `agent/keybindings.json` from this repo.

## Integration tests hard-depend on Neovim

`neovim-host.integration.test.ts` currently returns early from every test
when `Bun.which("nvim")` is falsy, so it silently passes wherever Neovim is
missing. Remove that soft skip entirely. Neovim is a hard requirement of the
package, so it is a hard requirement of its test suite: a missing binary must
fail the run, on CI and locally alike.

1. Delete the `if (!Bun.which("nvim")) return;` line from each integration
   test. Let `NeovimHost.start()` surface its own "Neovim 0.10 or newer was
   not found on PATH" error, which fails the test.
2. Install Neovim on the runner in both `ci.yml` and `publish.yml`, before
   `bun run check`:

   ```yaml
   - uses: rhysd/action-setup-vim@v1
     with:
       neovim: true
       version: stable
   ```

3. State the requirement in the README's Development section: `bun test`
   needs `nvim` on `PATH`.

The tests already use `--clean`, so they are independent of any user config.

## Verification

- `bun test` in the new repo runs every moved test, including the five
  integration tests, and reports the same pass count they had here.
- `./scripts/check.nu` in this repo still passes with only the personal test
  remaining.
- CI on the first push runs the integration tests, visible in the job log as
  non-trivial durations (they take 50 to 300 ms each with a real Neovim).
- Temporarily run `PATH=/usr/bin bun test` (or otherwise hide `nvim`) and
  confirm the five integration tests fail rather than pass.
