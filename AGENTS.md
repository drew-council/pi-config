# TypeScript checks and formatting

This repo uses `oxlint` for linting, `oxfmt` for formatting, and `tsc` for type checking.

Run `./scripts/check.nu` after TypeScript changes. It runs oxlint with fixes, oxfmt, `tsc`, then the Bun unit tests.

# Guidance

- When a change needs to be made to a pi npm extension/package, you can use `patch-package` to apply it.
- For pi packages installed from `git:` sources (cloned under the gitignored `agent/git/`), put a `git diff` of the checkout in `agent/git-patches/<repo>.patch`; `./scripts/patch-git-packages.nu` applies it (also run by `install.nu`).
- This pi installation is used on multiple machines; do not depend on gitignored files or directories being present everywhere.

