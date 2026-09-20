# 05 – Scaffold the package and declare runtime dependencies

Run after tasks 01 through 04 are merged.

## Scaffold

Use the existing script with the extension directory as the source. Suggested
invocation (adjust the name to taste):

```sh
./scripts/new-pi-extension.nu @bizmyth/pi-neovim-editor \
  --description "Embedded Neovim as the Pi coding agent prompt editor" \
  --source ./agent/extensions/neovim-editor \
  --github-repo drew-council/pi-neovim-editor
```

Do not pass `--create-github` or `--publish` on the first run. Inspect the
output first, then push and publish as separate steps once the checks pass.

Note: the `tasks/` directory will be copied into `src/` by the script. Delete
it from the new repo after scaffolding, or exclude it before running.

## Post-scaffold fixes the script does not handle

1. **Runtime dependency.** `nvim-host.ts` imports `@msgpack/msgpack`. The
   generated manifest has no `dependencies` block. Add:

   ```sh
   bun add --cwd ~/personal/pi-neovim-editor @msgpack/msgpack
   ```

   Confirm it lands in `dependencies`, not `devDependencies`. Pi installs
   packages with the configured npm command, so a missing runtime dependency
   fails at import time, not at install time.

2. **Lua files.** `lua/lua-scripts.ts` reads `.lua` files from disk via
   `import.meta.url`. They end up under `src/lua/` and `files: ["src"]`
   includes them. Confirm with `npm pack --dry-run` that the five `.lua` files
   are listed.

3. **`pi-tui` import.** `editor.ts`, `autocomplete.ts`, and `input.ts` import
   from `@earendil-works/pi-tui` directly. In this repo that resolves through
   the `paths` mapping in `tsconfig.json`. In the new repo it must resolve
   through `pi-coding-agent`'s own dependency tree. `pi-coding-agent` does
   not re-export the symbols the extension uses (`matchesKey`, `visibleWidth`,
   `parseKey`, `decodeKittyPrintable`, `isKeyRelease`, `SelectList`), so the
   direct import has to stay. Add `@earendil-works/pi-tui` as a peer
   dependency (`*`) and a dev dependency pinned to the same minor as the
   `pi-coding-agent` dev dependency, mirroring how the scaffold handles
   `pi-coding-agent`. Pi resolves peer dependencies from its own install, so
   this works at runtime without the user installing anything extra.

4. **Version floor.** The README and `resolveNeovim()` say Neovim 0.10. The
   code uses `nvim_win_text_height` and `smoothscroll` (both 0.10) and
   `vim.ui_attach` with `ext_messages` (still marked experimental upstream).
   0.10 is the correct floor; note the experimental API in the README (task
   07).

5. **Biome.** The generated `biome.json` uses the recommended preset. The
   extension already carries `biome-ignore` comments for control-character
   regexes. Run `bun run check:fix` and resolve anything new rather than
   loosening rules.

## Verification

- `bun run check` passes in the new repo (Biome, tsgo, bun test). Tests will
  fail until task 06 is done because they still live here; that is expected at
  this step.
- `npm pack --dry-run` lists `src/**/*.ts`, `src/lua/*.lua`, `README.md`,
  `LICENSE`.
- Install the local checkout into a scratch Pi config with
  `pi install /path/to/pi-neovim-editor` and confirm the editor mounts.
