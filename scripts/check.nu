#!/usr/bin/env nu

use std/assert
use utils.nu *

# Lint, format, type-check, and test the TypeScript in this repo.
# Run from anywhere with:
#   ./scripts/check.nu

def main [] {
  let repo = (repo-root)
  cd $repo

  let bun_dir = ($repo | path join "bun")
  let typecheck_dir = ($bun_dir | path join "typecheck" "node_modules")
  let tsc = ($bun_dir | path join "node_modules" ".bin" "tsc")

  for cmd in [oxlint oxfmt] {
    assert (which $cmd | is-not-empty) $"Missing ($cmd). Enter the flake devShell (direnv) first."
  }
  assert ($tsc | path exists) $"Missing tsc binary: ($tsc). Run ./scripts/install.nu first."

  let typecheck_pi_package = (pi-typecheck-package-path $repo)
  let typecheck_pi_types = ($typecheck_dir | path join "@earendil-works" "pi-coding-agent" "dist" "index.d.ts")
  let typecheck_tui_types = ($typecheck_dir | path join "@earendil-works" "pi-tui" "dist" "index.d.ts")

  for type_file in [$typecheck_pi_types $typecheck_tui_types] {
    assert ($type_file | path exists) $"Missing Pi type declarations: ($type_file). Run ./scripts/install.nu first."
  }

  let active_pi_version = (active-pi-version)
  let typecheck_pi_version = (open $typecheck_pi_package | get version)
  assert equal $active_pi_version $typecheck_pi_version $"Active pi version (($active_pi_version)) does not match installed type-check package version (($typecheck_pi_version)). Run ./scripts/install.nu to synchronize it."

  # Ignores live in oxlint.config.ts and oxfmt.config.ts; both also skip gitignored and
  # node_modules paths.
  say "Running oxlint with fixes"
  ^oxlint --fix --deny-warnings

  say "Running oxfmt"
  ^oxfmt

  say "Running tsc (TypeScript 7)"
  ^$tsc -p ($repo | path join "tsconfig.json")

  say "Running Bun unit tests"
  ^bun test ./agent/tests
}
