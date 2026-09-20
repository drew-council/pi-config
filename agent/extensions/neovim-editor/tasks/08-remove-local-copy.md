# 08 – Remove the local copy and its install hooks

Run after the package is published and confirmed working from npm on at least
one machine. Follow the pattern of the earlier factor-outs (`7cee1de` for
`@bizmyth/pi-review`, `ecaf69b` for `@bizmyth/pi-git-conflicts`).

## Changes in this repo

1. **Settings.** Add the published package to the `packages` array in
   `agent/settings.json` as `npm:<name>`.

2. **Delete the extension.** Remove `agent/extensions/neovim-editor/`
   entirely, including this `tasks/` directory.

3. **Delete moved tests.** Remove every test moved in task 06 from
   `agent/tests/extensions/`. Keep the personal keybindings test from task 04.

4. **Dependencies.** Remove `@msgpack/msgpack` from `agent/package.json`.
   Nothing else in `agent/` imports it (verified with a repo-wide grep at the
   time of writing). Regenerate `agent/bun.lock`:

   ```sh
   bun install --cwd agent
   ```

5. **Install script.** In `scripts/install.nu`, remove the
   `@msgpack/msgpack` entry from `required_local_packages`. Keep `nvim` in
   `required_commands`: every machine this config lands on has Neovim and
   uses the editor, so failing early is the right behaviour.

6. **Plans.** Remove the `neovim-editor` line from the factor-out list in
   `future-plans.md`.

## Verification

- `./scripts/check.nu` passes.
- `./scripts/install.nu` passes and no longer checks for `@msgpack/msgpack`.
- Start Pi, confirm the Neovim editor mounts from the npm package, type and
  submit a prompt, run `/reload`, confirm it comes back.
- `git grep -n neovim-editor` in this repo returns nothing.
