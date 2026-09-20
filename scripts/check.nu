#!/usr/bin/env nu

use std/assert
use utils.nu *

# Format/lint, type-check, and test the TypeScript in this repo.
# Run from anywhere with:
#   ./scripts/check.nu

def main [] {
  let repo = (repo-root)
  cd $repo

  let bun_dir = ($repo | path join "bun")
  let typecheck_dir = ($bun_dir | path join "typecheck" "node_modules")
  let biome = ($bun_dir | path join "node_modules" ".bin" "biome")
  let tsc = ($bun_dir | path join "node_modules" ".bin" "tsc")

  assert ($biome | path exists) $"Missing Biome binary: ($biome). Run ./scripts/install.nu first."
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

  let ts_files = (glob "**/*.ts" --exclude ["bun/**" ".git/**" ".pi/**" "agent/git/**" "agent/sessions/**"] | sort)

  if ($ts_files | is-empty) {
    say "No TypeScript files found."
  } else {
    say "Running Biome with unsafe fixes"
    ^$biome check --write --unsafe ...$ts_files

    say "Running tsc (TypeScript 7)"
    ^$tsc -p ($repo | path join "tsconfig.json")

    say "Running Bun unit tests"
    # Runtime imports must resolve executable JS, not tsc's declaration-only paths.
    ^bun test --tsconfig-override ./tsconfig.runtime.json ./agent/tests
  }

  let go_dir = ($repo | path join "agent" "skills" "github" "sheer-gh")
  say "Running Go vet"
  ^go -C $go_dir vet ./...

  if ((which golangci-lint) | is-empty) {
    print --stderr "warning: golangci-lint is not on PATH; skipping Go lint"
  } else {
    say "Running golangci-lint"
    do { cd $go_dir; ^golangci-lint run }
  }

  say "Running Go unit tests"
  ^go -C $go_dir test ./...
}
