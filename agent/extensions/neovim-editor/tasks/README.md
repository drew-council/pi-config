# Factor-out preparation tasks

Sequenced work to get the embedded Neovim editor ready to live in its own
published package. Tasks 01 and 02 must land in this repo before the
factor-out. Tasks 03b and 04 should also land before the move so the package
starts clean, but nothing depends on their order.
Tasks 05 through 08 happen during or after scaffolding the new repo.

| # | Task | Where | Blocking? |
|---|------|-------|-----------|
| 01 | [Resolve keybindings against Pi's effective config](01-effective-keybindings.md) | this repo | yes |
| 02 | [Drop the debug-handler release](02-gate-debug-handler.md) | this repo | yes |
| 03 | Reduce prompt history to stock Pi semantics | this repo | done |
| 03b | [Move `:pb` out of the extension into the Neovim config](03b-move-pb-to-nvim-config.md) | this repo + nixconf | no |
| 04 | [Keep the personal keybindings test local](04-split-keybindings-test.md) | this repo | no |
| 05 | [Scaffold the package and declare runtime dependencies](05-scaffold-package.md) | new repo | – |
| 06 | [Move and repoint the tests](06-move-tests.md) | new repo | – |
| 07 | [Rewrite the README for first-time users](07-readme.md) | new repo | – |
| 08 | [Remove the local copy and its install hooks](08-remove-local-copy.md) | this repo | – |

The persistent cross-session history that used to live in `history.ts` now
runs as a standalone local extension in `agent/extensions/history`.

Each task lists its motivation, the concrete changes, and how to verify it.
Run `./scripts/check.nu` after every task that touches TypeScript in this repo.
