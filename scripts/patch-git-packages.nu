#!/usr/bin/env nu

use utils.nu *

# Apply local patches to Pi-managed git packages (the `git:` sources in
# agent/settings.json). Pi clones those under agent/git/github.com/<owner>/<repo>,
# which is gitignored, so edits there do not travel with this repo. Patches live
# in agent/git-patches/<repo>.patch and are produced with `git diff` inside the
# package checkout. Each patch is skipped when already applied, so this is safe
# to rerun after `pi update`.
#
# Usage:
#   ./scripts/patch-git-packages.nu

def package-dir [agent_dir: string repo: string] {
  let matches = (glob ($agent_dir | path join "git" "github.com" "*" $repo) | where {|p| ($p | path type) == "dir" })
  if ($matches | is-empty) { null } else { $matches | first }
}

def main [] {
  let repo = (repo-root)
  let agent_dir = ($repo | path join "agent")
  let patch_dir = ($agent_dir | path join "git-patches")

  if not ($patch_dir | path exists) {
    say $"No git package patches found: ($patch_dir)"
    return
  }

  for patch in (glob ($patch_dir | path join "*.patch") | sort) {
    let name = ($patch | path basename | str replace --regex '\.patch$' '')
    let dir = (package-dir $agent_dir $name)

    if $dir == null {
      print --stderr $"warning: git package ($name) is not installed under ($agent_dir | path join 'git'); skipping ($patch)"
      continue
    }

    let already_applied = (do { ^git -C $dir apply --reverse --check $patch } | complete | get exit_code) == 0
    if $already_applied {
      say $"Patch already applied: ($name)"
      continue
    }

    say $"Applying patch to ($name)"
    ^git -C $dir apply --check $patch
    ^git -C $dir apply $patch

    # A patch may change package.json dependencies; refresh the install so the
    # runtime matches. Pi installs git packages with Bun (settings.npmCommand).
    ^bun install --cwd $dir
  }
}
