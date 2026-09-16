#!/usr/bin/env bash
# Releases: CalVer tags (vYYYY-MM-DD.N), auto-generated notes, and "is my change in that release?".
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: release.sh <command> [args]

  list [n]                    recent releases (default 10)
  show [tag]                  a release's notes (default latest)
  contains <pr|sha> [tag]     is the PR's merge commit (or a sha) in that release? default latest. exit 0 yes, 1 no
  first <pr|sha>              the earliest release that contains the change
  next-tag [--hotfix]         the next CalVer tag for today
  draft [--target <sha>] [--tag <tag>]
                              create a DRAFT release with GitHub-generated notes (never publishes)

Release notes come from .github/release.yml, grouped by PR label (highlight, internal, dependencies).
EOF
}

resolve_sha() {
  local ref="$1"
  if [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]]; then
    printf '%s' "$ref"
    return
  fi
  local n
  n="$(number_of "$ref")"
  local j
  j="$(gh pr view "$n" --repo "$REPO_SLUG" --json state,mergeCommit)"
  [[ "$(jq -r .state <<<"$j")" == "MERGED" ]] || die "PR #$n is not merged"
  jq -r .mergeCommit.oid <<<"$j"
}

latest_tag() { gh release view --repo "$REPO_SLUG" --json tagName --jq .tagName; }

# 0 if $2 (sha) is reachable from $1 (tag).
in_tag() {
  local status
  status="$(gh api "repos/$REPO_SLUG/compare/$1...$2" --jq .status 2>/dev/null)" || die "compare failed for $1...$2"
  [[ "$status" == "behind" || "$status" == "identical" ]]
}

cmd_list() {
  gh release list --repo "$REPO_SLUG" --limit "${1:-10}" --json tagName,isDraft,isPrerelease,isLatest,publishedAt \
    --jq '.[] | "\(.tagName)\t\(.publishedAt // "unpublished" | .[:16])\t\(if .isDraft then "draft" elif .isPrerelease then "pre" elif .isLatest then "latest" else "" end)"'
}

cmd_show() {
  local tag="${1:-}"
  if [[ -n "$tag" ]]; then gh release view "$tag" --repo "$REPO_SLUG"; else gh release view --repo "$REPO_SLUG"; fi
}

cmd_contains() {
  local sha tag
  sha="$(resolve_sha "${1:?pr or sha}")"
  tag="${2:-$(latest_tag)}"
  if in_tag "$tag" "$sha"; then echo "yes: ${sha:0:12} is in $tag"; else
    echo "no: ${sha:0:12} is not in $tag"
    exit 1
  fi
}

cmd_first() {
  local sha
  sha="$(resolve_sha "${1:?pr or sha}")"
  local tags found=""
  tags="$(gh release list --repo "$REPO_SLUG" --limit 40 --exclude-drafts --json tagName --jq '.[].tagName')"
  for t in $tags; do
    if in_tag "$t" "$sha"; then found="$t"; else break; fi
  done
  [[ -n "$found" ]] || {
    echo "not in any of the last 40 releases"
    exit 1
  }
  echo "$found"
}

cmd_next_tag() {
  local hotfix=false
  [[ "${1:-}" == "--hotfix" ]] && hotfix=true
  local day
  day="$(date +%Y-%m-%d)"
  local n
  n="$(gh api "repos/$REPO_SLUG/git/matching-refs/tags/v$day." --jq '[.[].ref | capture("\\.(?<i>[0-9]+)") | .i | tonumber] | max // -1' 2>/dev/null || echo -1)"
  local tag="v$day.$((n + 1))"
  $hotfix && tag="$tag-hotfix"
  echo "$tag"
}

cmd_draft() {
  local target="" tag=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --target)
      target="$2"
      shift
      ;;
    --tag)
      tag="$2"
      shift
      ;;
    *) die "unknown option: $1" ;;
    esac
    shift
  done
  [[ -n "$target" ]] || target="$(gh api "repos/$REPO_SLUG/commits/main" --jq .sha)"
  [[ -n "$tag" ]] || tag="$(cmd_next_tag)"
  echo "drafting $tag at ${target:0:12}" >&2
  gh release create "$tag" --repo "$REPO_SLUG" --draft --generate-notes --title "$tag" --target "$target"
}

case "${1:-}" in
list)
  shift
  cmd_list "$@"
  ;;
show)
  shift
  cmd_show "$@"
  ;;
contains)
  shift
  cmd_contains "$@"
  ;;
first)
  shift
  cmd_first "$@"
  ;;
next-tag)
  shift
  cmd_next_tag "$@"
  ;;
draft)
  shift
  cmd_draft "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
