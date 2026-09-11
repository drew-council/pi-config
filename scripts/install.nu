#!/usr/bin/env nu

# Bootstrap this Pi configuration on a new machine.
#
# What this does:
# - installs the local Bun dependency workspace under ./bun
# - applies patch-package patches from ./patches via Bun's postinstall
# - applies patch-package patches from ./agent/patches to Pi-managed npm packages
# - updates/installs Pi-managed npm packages with Bun from agent/settings.json
# - initializes isolated work/personal accounts, reusing gh and existing Codex logins
# - generates local personal/Sheer Health secret files from committed 1Password templates
# - verifies that Neovim is available for the embedded prompt editor
# - verifies that Pi can resolve the configured packages
#
# Usage:
#   ./scripts/install.nu
#   ./scripts/install.nu --pull              # also git pull --ff-only --autostash first
#   ./scripts/install.nu --skip-pi-update    # do not run `pi update --extensions`
#   ./scripts/install.nu --skip-pi-list      # do not run final `pi list`
#   ./scripts/install.nu --force-inject      # regenerate secret files even when their keys match

use utils.nu *

def command-exists [cmd: string] {
  not ((which $cmd) | is-empty)
}

def json-key-paths [value: any prefix: string = ""] {
  if not (($value | describe) | str starts-with "record") {
    return []
  }

  $value
  | columns
  | each {|key|
    let path = if ($prefix | is-empty) { $key } else { $"($prefix).($key)" }
    [$path ...(json-key-paths ($value | get $key) $path)]
  }
  | flatten
  | sort
}

def secret-keys-match [template_file: string secret_file: string] {
  if not ($secret_file | path exists) {
    return false
  }

  let expected_keys = (json-key-paths (open --raw $template_file | from json))
  let existing_keys = (
    try {
      json-key-paths (open --raw $secret_file | from json)
    } catch {
      []
    }
  )

  $existing_keys == $expected_keys
}

def apply-agent-npm-patches [bun_dir: string agent_dir: string] {
  let patch_package = ($bun_dir | path join "node_modules" ".bin" "patch-package")
  let patch_dir = ($agent_dir | path join "patches")
  let patch_dir_relative = "../patches"
  let agent_npm_dir = ($agent_dir | path join "npm")

  if not ($patch_package | path exists) {
    error make {msg: $"Missing patch-package binary: ($patch_package)"}
  }

  if not ($patch_dir | path exists) {
    say $"No agent npm patches found: ($patch_dir)"
    return
  }

  say "Applying Pi-managed npm package patches"
  do { cd $agent_npm_dir; ^bun $patch_package --patch-dir $patch_dir_relative --error-on-fail }
}

def migrate-agent-packages-to-bun [agent_dir: string] {
  let package_dir = ($agent_dir | path join "npm")
  let package_json = ($package_dir | path join "package.json")
  let bun_lock = ($package_dir | path join "bun.lock")
  let legacy_lock = ($package_dir | path join "package-lock.json")

  if (($package_json | path exists) and not ($bun_lock | path exists)) {
    say "Migrating existing Pi-managed packages to Bun"
    ^bun install --cwd $package_dir --omit=peer
  }

  if ($legacy_lock | path exists) {
    rm $legacy_lock
  }
}

def npm-package-name [source: string] {
  let spec = ($source | str replace --regex '^npm:' '')
  let parts = ($spec | split row "@")

  if ($spec | str starts-with "@") {
    $"@($parts | get 1)"
  } else {
    $parts | first
  }
}

def ensure-agent-npm-packages [agent_dir: string] {
  let settings_file = ($agent_dir | path join "settings.json")
  let agent_npm_dir = ($agent_dir | path join "npm")
  let configured_packages = (open $settings_file | get -o packages | default [])

  say "Ensuring all configured Pi-managed npm packages are installed"
  for configured_package in $configured_packages {
    let source = if (($configured_package | describe) == "string") {
      $configured_package
    } else {
      $configured_package.source
    }

    if not ($source | str starts-with "npm:") {
      continue
    }

    let package_name = (npm-package-name $source)
    let package_json = ([$agent_npm_dir "node_modules" ...($package_name | split row "/") "package.json"] | path join)

    if not ($package_json | path exists) {
      print $"    Installing missing configured package ($source)"
      ^pi install $source
    }

    if not ($package_json | path exists) {
      error make {msg: $"Pi reported that ($source) was installed, but ($package_json) is still missing."}
    }
  }
}

def main [
  --pull (-p) # Pull this repo before installing.
  --skip-pi-update # Skip `pi update --extensions`.
  --skip-pi-list # Skip final `pi list` verification.
  --force-inject # Regenerate secret files even when their keys match.
] {
  let repo = (repo-root)
  cd $repo

  let bun_dir = ($repo | path join "bun")
  let typecheck_dir = ($bun_dir | path join "typecheck")
  let agent_dir = ($repo | path join "agent")
  let secrets_dir = ($repo | path join "secrets")
  let personal_secrets = ($secrets_dir | path join "personal.json")
  let work_secrets = ($secrets_dir | path join "work.json")
  # Account UUIDs reported by `op account list --format=json`.
  let personal_account = "XH4EFF5WXBGXJOIXZG4PLGILIE"
  let work_account = "QIWPEOJ6R5GXPJFYBZFU5VL6KI" # sheerhealth.1password.com

  say $"Pi config repo: ($repo)"

  if not (($repo | path join "agent" "settings.json") | path exists) {
    error make {msg: $"This does not look like the Pi config repo: missing ($repo | path join 'agent' 'settings.json')"}
  }

  if not ($bun_dir | path exists) {
    error make {msg: $"Missing Bun dependency workspace: ($bun_dir)"}
  }

  if not (($agent_dir | path join "package.json") | path exists) {
    error make {msg: $"Missing agent package manifest: ($agent_dir | path join 'package.json')"}
  }

  let personal_template = ($secrets_dir | path join "personal.json.tpl")
  let work_template = ($secrets_dir | path join "work.json.tpl")

  let required_commands = ["bun" "pi" "nvim"]
  for cmd in $required_commands {
    if not (command-exists $cmd) {
      error make {msg: $"Missing required command `($cmd)`. Install it, ensure it is on PATH, and rerun this script."}
    }
  }

  if $pull {
    if not (command-exists "git") {
      error make {msg: "Missing required command `git`."}
    }

    if not (($repo | path join ".git") | path exists) {
      error make {msg: $"Cannot --pull because this is not a git checkout: ($repo)"}
    }

    say "Updating git checkout"
    ^git pull --ff-only --autostash
  }

  let inject_personal = ($force_inject or not (secret-keys-match $personal_template $personal_secrets))
  let inject_work = ($force_inject or not (secret-keys-match $work_template $work_secrets))
  if ($inject_personal or $inject_work) and not (command-exists "op") {
    error make {msg: "Missing required command `op`; a secret file needs to be generated."}
  }

  if $inject_personal {
    say "Generating personal secret file"
    ^op --account $personal_account inject --in-file $personal_template --out-file $personal_secrets --force
  } else {
    say "Personal secret file already has the expected keys; skipping 1Password injection"
  }

  if $inject_work {
    say "Generating Sheer Health work secret file"
    ^op --account $work_account inject --in-file $work_template --out-file $work_secrets --force
  } else {
    say "Work secret file already has the expected keys; skipping 1Password injection"
  }
  ^chmod 600 $personal_secrets $work_secrets

  say "Installing Bun dependency workspace and applying patches"
  ^bun install --cwd $bun_dir --frozen-lockfile

  # Keep the active Pi declarations separate from the locked workspace because
  # their version follows the system Pi installation.
  let active_pi_version = (active-pi-version)
  say $"Installing type declarations for Pi ($active_pi_version)"
  ^bun install $"@earendil-works/pi-coding-agent@($active_pi_version)" --cwd $typecheck_dir --no-save

  let typecheck_pi_package = (pi-typecheck-package-path $repo)
  if not ($typecheck_pi_package | path exists) {
    error make {msg: $"Pi type-check package was not installed: ($typecheck_pi_package)"}
  }
  let typecheck_pi_version = (open $typecheck_pi_package | get version)
  if $typecheck_pi_version != $active_pi_version {
    error make {msg: $"Installed Pi type-check package version (($typecheck_pi_version)) does not match active Pi (($active_pi_version))."}
  }

  say "Installing agent extension dependencies with Bun"
  ^bun install --cwd $agent_dir --frozen-lockfile

  let required_local_packages = [
    ($agent_dir | path join "node_modules" "@msgpack" "msgpack")
    ($agent_dir | path join "node_modules" "qrcode")
    ($agent_dir | path join "node_modules" "remark-parse")
    ($agent_dir | path join "node_modules" "unified")
    ($agent_dir | path join "node_modules" "ws")
  ]

  for pkg in $required_local_packages {
    if not ($pkg | path exists) {
      error make {msg: $"Expected local package was not installed: ($pkg)"}
    }
  }

  # Pi always stores registry packages under agent/npm, regardless of which
  # package manager installs them. Convert installations left by older setups.
  migrate-agent-packages-to-bun $agent_dir

  # `pi update --extensions` deliberately skips pinned npm specs, including
  # packages which have never been installed. Reconcile missing packages first
  # so every configured package exists before optional updates and patching.
  ensure-agent-npm-packages $agent_dir

  if not $skip_pi_update {
    say "Updating/installing Pi-managed packages from settings"
    ^pi update --extensions
  }

  apply-agent-npm-patches $bun_dir $agent_dir

  say "Initializing account profiles (browser logins remain available through /log-me-in)"
  ^bun --tsconfig-override ($repo | path join "tsconfig.runtime.json") ($agent_dir | path join "scripts" "setup-accounts.ts")

  if not $skip_pi_list {
    say "Verifying Pi package resolution"
    ^pi list
  }

  say "Done. Restart Pi to load any newly installed or patched extensions."
}
