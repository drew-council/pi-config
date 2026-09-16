#!/usr/bin/env bash
# Shared constants and helpers for the github skill scripts.
# Source this file; do not run it.
# shellcheck disable=SC2034  # constants are used by the sourcing scripts
set -euo pipefail

OWNER="${SHEER_GH_OWNER:-sheerhealth}"
REPO="${SHEER_GH_REPO:-sheer}"
REPO_SLUG="$OWNER/$REPO"
PROJECT_NUMBER="${SHEER_GH_PROJECT:-9}"
SPRINT_FIELD="Sprint"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
warn() { printf 'warning: %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required on PATH"; }

need gh
need jq

gql() { gh api graphql "$@"; }

# Root of the checkout the caller is working in. This skill lives outside the
# repo, so resolve from the working directory rather than the script's location.
repo_root() { git rev-parse --show-toplevel 2>/dev/null || true; }

# Strip a leading '#' or a full issue/PR URL down to the number.
number_of() {
  local ref="$1"
  ref="${ref##*/}"
  ref="${ref#\#}"
  [[ "$ref" =~ ^[0-9]+$ ]] || die "not an issue or PR number: $1"
  printf '%s' "$ref"
}

# Read a body from --body or --body-file; '-' reads stdin.
read_body() {
  local body="$1" file="$2"
  if [[ -n "$file" ]]; then
    if [[ "$file" == "-" ]]; then cat; else cat "$file"; fi
  else
    printf '%s' "$body"
  fi
}

# The login gh is authenticated as.
me() { gh api user --jq .login; }

# Attribution line prepended to comments an agent writes on someone's behalf.
attribution() {
  local agent="${AGENT_NAME:-an AI coding agent}"
  printf '> _Written by %s on behalf of @%s._\n\n' "$agent" "$(me)"
}
