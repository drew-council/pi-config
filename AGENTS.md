My github username is @drew-council

# TypeScript checks and formatting

This repo uses `biome` for TypeScript linting/formatting and `tsc` for type checking.

Run `./scripts/check.nu` after TypeScript changes. It runs Biome with unsafe fixes, then `tsc` over the repo's TypeScript files.

# Guidance

- Use the `github` skill for GitHub operations. Its CLI lives in `agent/skills/github/sheer-gh` and is checked by `./scripts/check.nu`.
- When a change needs to be made to a pi npm extension/package, you can use `patch-package` to apply it.
- For pi packages installed from `git:` sources (cloned under the gitignored `agent/git/`), put a `git diff` of the checkout in `agent/git-patches/<repo>.patch`; `./scripts/patch-git-packages.nu` applies it (also run by `install.nu`).
- This pi installation is used on multiple machines; do not depend on gitignored files or directories being present everywhere.

