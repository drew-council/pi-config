# Pi Config Tasks

Task definitions for this Pi configuration repo, run with [mask](https://github.com/jacobdeichert/mask).

Almost every command is a thin alias for a script in [`./scripts`](./scripts), so
`mask <command> --help` covers the underlying script's own flags and behavior.

These commands assume the Nix dev shell (direnv) for `nu`, `bun`, `nix`, `oxlint`, and `oxfmt`.
Each one `cd`s to `$MASKFILE_DIR` first, so it also works via `mask --maskfile ~/.pi/maskfile.md`.

## install

> Bootstrap Pi on this machine: Bun workspace and patches, git package patches, generated skills, Pi packages, account profiles, and 1Password secret files.

Runs `./scripts/install.nu`. Read the script header for the full sequence. It is idempotent, so
rerunning it after pulling changes is the normal workflow.

**OPTIONS**
* pull
    * flags: -p --pull
    * desc: Run `git pull --ff-only --autostash` before installing
* skip_pi_update
    * flags: --skip-pi-update
    * desc: Skip the `pi update --extensions` step
* skip_pi_list
    * flags: --skip-pi-list
    * desc: Skip the final `pi list` verification
* force_inject
    * flags: --force-inject
    * desc: Regenerate the secret files even when their existing keys match

```nu
cd $env.MASKFILE_DIR
let args = (
  [
    (if $env.pull? == "true" { ["--pull"] } else { [] })
    (if $env.skip_pi_update? == "true" { ["--skip-pi-update"] } else { [] })
    (if $env.skip_pi_list? == "true" { ["--skip-pi-list"] } else { [] })
    (if $env.force_inject? == "true" { ["--force-inject"] } else { [] })
  ] | flatten
)
nu ./scripts/install.nu ...$args
```

## check

> Run the TypeScript checks: oxlint with fixes, oxfmt, `tsc` (TypeScript 7), then the Bun unit tests.

Runs `./scripts/check.nu`. This is the command to run after any TypeScript change. It also verifies
that the installed Pi type declarations match the active `pi` version, and tells you to rerun
`mask install` when they do not.

```nu
cd $env.MASKFILE_DIR
nu ./scripts/check.nu
```

## format

> Format the whole repo with treefmt (`nix fmt`), the same formatter the pre-commit hook uses.

The pre-commit hook only formats staged files (`nix fmt <paths>`); this command formats everything.
Options and ignores live in [`treefmt.nix`](./treefmt.nix) and [`oxfmt.config.ts`](./oxfmt.config.ts).

```nu
cd $env.MASKFILE_DIR
nix fmt
```

## test

> Run only the Bun unit tests, skipping lint, format, and type checks.

Useful while iterating; run `mask check` before committing.

```nu
cd $env.MASKFILE_DIR
bun test ./agent/tests
```

## sync-skills

> Regenerate the Pi, Codex, and Claude Code skill directories from `./skills`.

Runs `scripts/sync-skills.ts`. Never edit the generated copies under `agent/skills/`,
`~/.codex/skills/`, or `~/.claude/skills/`; edit `./skills/<name>/` instead.

```nu
cd $env.MASKFILE_DIR
bun ./scripts/sync-skills.ts
```

## setup-accounts

> Reinitialize the isolated work and personal account profiles, reusing existing `gh`, Vertex AI, and Codex logins.

Runs `agent/scripts/setup-accounts.ts`. `mask install` already runs this.

```nu
cd $env.MASKFILE_DIR
bun ./agent/scripts/setup-accounts.ts
```

## patch-git-packages

> Apply `agent/git-patches/<repo>.patch` to the `git:` packages Pi cloned under `agent/git/`.

Runs `./scripts/patch-git-packages.nu`. Patches already applied are skipped, so it is safe to rerun
after `pi update --extensions`. `mask install` already runs this.

```nu
cd $env.MASKFILE_DIR
nu ./scripts/patch-git-packages.nu
```

## new-pi-extension (package_name)

> Scaffold a publishable Pi extension package in its own git repository.

Runs `./scripts/new-pi-extension.nu`. The package is created at `~/personal/<basename>` unless
`--directory` is given.

**OPTIONS**
* description
    * flags: --description
    * type: string
    * desc: Package description (default: `A Pi coding agent extension`)
* directory
    * flags: -d --directory
    * type: string
    * desc: Target directory (default: `~/personal/<package basename>`)
* source
    * flags: --source
    * type: string
    * desc: Existing extension file or directory to copy into the package's `src/` directory
* github_repo
    * flags: --github-repo
    * type: string
    * desc: Add repository metadata for an `owner/name` GitHub repo
* create_github
    * flags: --create-github
    * desc: Create and push `--github-repo` as a public repository
* publish
    * flags: --publish
    * desc: Publish to npm, then configure GitHub Actions trusted publishing
* skip_install
    * flags: --skip-install
    * desc: Do not install dependencies or run the generated checks

```nu
cd $env.MASKFILE_DIR
let args = (
  [$env.package_name]
  | append (if $env.description? == null { [] } else { ["--description" $env.description] })
  | append (if $env.directory? == null { [] } else { ["--directory" $env.directory] })
  | append (if $env.source? == null { [] } else { ["--source" $env.source] })
  | append (if $env.github_repo? == null { [] } else { ["--github-repo" $env.github_repo] })
  | append (if $env.create_github? == "true" { ["--create-github"] } else { [] })
  | append (if $env.publish? == "true" { ["--publish"] } else { [] })
  | append (if $env.skip_install? == "true" { ["--skip-install"] } else { [] })
)
nu ./scripts/new-pi-extension.nu ...$args
```

## Notes

- `mask install --pull` is the "update this machine" command.
- `mask check` is the "before committing" command.
- `agent/settings.json` is rewritten by Pi itself and by `scripts/format-pi-settings.ts`; do not hand-format it.
- Secrets come from 1Password templates (`secrets/*.json.tpl`); never commit generated `secrets/*.json`.
