# TypeScript checks and formatting

This repo uses `oxlint` for linting, `oxfmt` for formatting, and `tsc` for type checking.

Run `./scripts/check.nu` after TypeScript changes. It runs oxlint with fixes, oxfmt, `tsc`, then the Bun unit tests.

# Guidance

- When a change needs to be made to a pi npm extension/package, you can use `patch-package` to apply it.
- For pi packages installed from `git:` sources (cloned under the gitignored `agent/git/`), put a `git diff` of the checkout in `agent/git-patches/<repo>.patch`; `./scripts/patch-git-packages.nu` applies it (also run by `install.nu`).
- This pi installation is used on multiple machines; do not depend on gitignored files or directories being present everywhere.
- Skills live in `./skills/<name>/` and are generated into `agent/skills/` (Pi), `~/.codex/skills/`, and `~/.claude/skills/` by `scripts/sync-skills.ts` (run by `install.nu`); never edit the generated copies. The script's header documents the frontmatter (`targets`, `source`), `upstream.patch`, and `{{skillDir}}`.
- `agent/AGENTS.md` is copied to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` by the same script; never edit the copies.
