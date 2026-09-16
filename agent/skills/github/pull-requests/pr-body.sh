#!/usr/bin/env bash
# PR description helpers: print the repo template, lint a body against it and the house rules,
# and show recent merged PRs as style references.
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: pr-body.sh <command> [args]

  template                 print .github/pull_request_template.md (its comments explain each section)
  check <pr|file>          lint a PR body, by PR number or local markdown file
  recent [n] [--author L]  bodies of the last n merged PRs (default 3) as style references

check exits 1 when a rule fails; warnings do not change the exit code.
EOF
}

TEMPLATE="$(repo_root)/.github/pull_request_template.md"

need_template() {
  [[ -f "$TEMPLATE" ]] || die "cannot find .github/pull_request_template.md; run this from a $REPO_SLUG checkout"
}

cmd_template() {
  need_template
  cat "$TEMPLATE"
}

template_headings() {
  need_template
  grep -E '^## ' "$TEMPLATE"
}

lint_body() {
  local body="$1" changed="${2:-}" labels="${3:-}"
  body="${body//$'\r'/}"
  local fail=0
  grep -q '<!--' <<<"$body" && echo "warn template comments are still in the body; delete them"
  # Rules below look at the author's text, not the template's guidance comments.
  body="$(perl -0pe 's/<!--.*?-->//gs' <<<"$body")"

  # Headings from the template, present and in order.
  local last=0 h line
  while IFS= read -r h; do
    line="$(grep -n -F -x "$h" <<<"$body" | head -1 | cut -d: -f1 || true)"
    if [[ -z "$line" ]]; then
      echo "FAIL missing heading '$h'"
      fail=1
    elif ((line < last)); then
      echo "FAIL heading '$h' is out of template order"
      fail=1
    else
      last=$line
    fi
  done < <(template_headings)

  # Empty sections, for headings that are present.
  while IFS= read -r h; do
    grep -q -F -x "$h" <<<"$body" || continue
    awk -v h="$h" 'BEGIN{p=0;c=0} $0==h{p=1;next} /^## /{p=0} p && /[^[:space:]]/{c++} END{exit c>0}' <<<"$body" &&
      echo "warn section '$h' is empty"
  done < <(template_headings | grep -v 'External Testing')

  # Linked issue, mirroring .github/workflows/check-linked-issue.yml.
  local issue_refs
  issue_refs="$(grep -oE '(#[0-9]+|github\.com/sheerhealth/sheer/issues/[0-9]+|security/dependabot/[0-9]+)' <<<"$body" | sort -u || true)"
  if [[ -z "$issue_refs" ]]; then
    if [[ "$labels" == *debt* ]]; then
      echo "ok   no issue linked, allowed by the 'debt' label"
    elif [[ -n "$changed" && "$changed" -le 50 ]]; then
      echo "ok   no issue linked, allowed for a diff of $changed lines"
    else
      echo "FAIL no issue linked; the check-linked-issue workflow fails PRs over 50 lines without one"
      fail=1
    fi
  else
    grep -qE '(Closes|Fixes|Resolves) ' <<<"$body" || echo "warn issue is mentioned without a closing keyword (Closes #N moves the board automatically)"
  fi

  grep -qiE '\bstack(ed)?\b|previous in stack|next in stack|part [0-9]+ of' <<<"$body" &&
    echo "warn references the stack; GitHub shows stack order itself, so leave it out"
  grep -qiE 'not (in|part of) this PR|does not include|out of scope|will (be|come) (in|as) a follow' <<<"$body" &&
    echo "warn describes what is not in the PR; say only what is"
  grep -q '—' <<<"$body" && echo "warn contains an em dash"
  grep -qE 'Generated with|Co-Authored-By' <<<"$body" && echo "warn has a generated-with trailer; recent PRs in this repo do not carry one"

  local words
  words="$(wc -w <<<"$body" | tr -d ' ')"
  ((words > 300)) && echo "warn $words words; most merged PR bodies are under 200. Cut to what a reviewer needs"
  return "$fail"
}

cmd_check() {
  local target="${1:?pr number or file}"
  if [[ -f "$target" ]]; then
    lint_body "$(cat "$target")"
  else
    local n
    n="$(number_of "$target")"
    local j
    j="$(gh pr view "$n" --repo "$REPO_SLUG" --json body,additions,deletions,labels,isDraft,title)"
    echo "#$n $(jq -r .title <<<"$j") (draft=$(jq -r .isDraft <<<"$j"))"
    lint_body "$(jq -r .body <<<"$j")" "$(jq -r '.additions+.deletions' <<<"$j")" "$(jq -r '.labels|map(.name)|join(",")' <<<"$j")"
  fi
}

cmd_recent() {
  local n=3 author=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --author)
      author="$2"
      shift
      ;;
    *) n="$1" ;;
    esac
    shift
  done
  local args=(--repo "$REPO_SLUG" --state merged --limit "$n" --json "number,title,author,body")
  [[ -n "$author" ]] && args+=(--author "$author")
  gh pr list "${args[@]}" --jq '.[] | "===== #\(.number) \(.title) (@\(.author.login))\n\(.body)\n"'
}

case "${1:-}" in
template) cmd_template ;;
check)
  shift
  cmd_check "$@"
  ;;
recent)
  shift
  cmd_recent "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
