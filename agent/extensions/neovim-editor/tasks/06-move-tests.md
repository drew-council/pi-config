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
| `neovim-editor-debug-key.test.ts` | created in task 04, if task 02 kept the handler |
| `neovim-host.integration.test.ts` | spawns real `nvim --clean --embed`, see below |
| new effective-keybindings test from task 01 | move as is |

## Do not move

- The personal keybindings assertion split out in task 04. It reads
  `agent/keybindings.json` from this repo.

## Integration test in CI

`neovim-host.integration.test.ts` returns early when `Bun.which("nvim")` is
falsy, so it silently passes on a runner without Neovim. That hides
regressions. In the new repo's `ci.yml`, install Neovim before running checks
so the integration tests actually execute:

```yaml
- uses: rhysd/action-setup-vim@v1
  with:
    neovim: true
    version: stable
```

Then change the early return in each integration test to a hard failure when
`process.env.CI` is set, so a broken Neovim install on CI cannot be mistaken
for a pass.

The tests already use `--clean`, so they are independent of any user config.

## Verification

- `bun test` in the new repo runs every moved test, including the five
  integration tests, and reports the same pass count they had here.
- `./scripts/check.nu` in this repo still passes with only the personal test
  remaining.
- CI on the first push runs the integration tests, visible in the job log as
  non-trivial durations (they take 50 to 300 ms each with a real Neovim).
