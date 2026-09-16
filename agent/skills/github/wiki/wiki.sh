#!/usr/bin/env bash
# The repo wiki is a git repository (sheerhealth/sheer.wiki.git) of flat markdown pages.
# This keeps a local clone and reads pages from it; GitHub has no API for wiki content.
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need git

WIKI_DIR="${SHEER_WIKI_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/sheer-wiki}"
WIKI_URL="https://github.com/$REPO_SLUG.wiki.git"

usage() {
  cat <<EOF
usage: wiki.sh <command> [args]

  sync               clone or fast-forward the local clone ($WIKI_DIR)
  list               page titles
  search <words>...  pages whose text matches, with matching lines
  show <page>        print a page as markdown (name is case-insensitive; spaces and hyphens are interchangeable)
  path <page>        print the local file path of a page (for editing)

Every command syncs first if the clone is missing or older than a day. Set SHEER_WIKI_DIR to move the clone.
Page URL form: https://github.com/$REPO_SLUG/wiki/<Page-Name>
EOF
}

sync() {
  if [[ ! -d "$WIKI_DIR/.git" ]]; then
    git clone -q "$WIKI_URL" "$WIKI_DIR" || die "clone failed; check gh auth and network"
    echo "cloned wiki to $WIKI_DIR" >&2
  else
    git -C "$WIKI_DIR" pull -q --ff-only || warn "pull failed; using the existing clone"
  fi
}

maybe_sync() {
  if [[ ! -d "$WIKI_DIR/.git" ]]; then
    sync
    return
  fi
  local stamp="$WIKI_DIR/.git/FETCH_HEAD"
  if [[ ! -f "$stamp" ]] || [[ -n "$(find "$stamp" -mtime +1 2>/dev/null)" ]]; then sync; fi
}

title_of() {
  local f
  f="$(basename "$1" .md)"
  printf '%s' "${f//-/ }"
}

# Resolve a page name to a file. Exact match, then prefix, then substring.
resolve() {
  local want="$1" norm
  norm="$(tr ' ' '-' <<<"$want" | tr '[:upper:]' '[:lower:]')"
  local f exact=() prefix=() sub=()
  for f in "$WIKI_DIR"/*.md; do
    local b
    b="$(basename "$f" .md | tr '[:upper:]' '[:lower:]')"
    [[ "$b" == _* ]] && continue
    if [[ "$b" == "$norm" ]]; then
      exact+=("$f")
    elif [[ "$b" == "$norm"* ]]; then
      prefix+=("$f")
    elif [[ "$b" == *"$norm"* ]]; then sub+=("$f"); fi
  done
  local hits=("${exact[@]+"${exact[@]}"}")
  [[ ${#hits[@]} -eq 0 ]] && hits=("${prefix[@]+"${prefix[@]}"}")
  [[ ${#hits[@]} -eq 0 ]] && hits=("${sub[@]+"${sub[@]}"}")
  case ${#hits[@]} in
  0) die "no page matches '$want' (run: wiki.sh list)" ;;
  1) printf '%s' "${hits[0]}" ;;
  *)
    {
      echo "ambiguous '$want'; matches:"
      for f in "${hits[@]}"; do echo "  $(title_of "$f")"; done
    } >&2
    exit 1
    ;;
  esac
}

cmd_list() {
  maybe_sync
  for f in "$WIKI_DIR"/*.md; do
    local b
    b="$(basename "$f")"
    [[ "$b" == _* ]] && continue
    title_of "$f"
    echo
  done
}

cmd_search() {
  maybe_sync
  [[ $# -gt 0 ]] || die "search needs words"
  local pattern="$*"
  local f
  for f in "$WIKI_DIR"/*.md; do
    [[ "$(basename "$f")" == _* ]] && continue
    if grep -qi -- "$pattern" "$f"; then
      echo "== $(title_of "$f")"
      grep -ni -m 5 -- "$pattern" "$f" | cut -c1-200 | sed 's/^/   /'
    fi
  done
}

cmd_show() {
  maybe_sync
  local f
  f="$(resolve "${1:?page}")"
  echo "<!-- https://github.com/$REPO_SLUG/wiki/$(basename "$f" .md) -->"
  cat "$f"
}

cmd_path() {
  maybe_sync
  resolve "${1:?page}"
  echo
}

case "${1:-}" in
sync) sync ;;
list) cmd_list ;;
search)
  shift
  cmd_search "$@"
  ;;
show)
  shift
  cmd_show "$@"
  ;;
path)
  shift
  cmd_path "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
