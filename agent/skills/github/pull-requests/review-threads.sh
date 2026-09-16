#!/usr/bin/env bash
# Inline review threads on a PR: list them with the ids you need, reply, resolve.
# `gh pr view --comments` only shows top-level conversation, not inline threads.
# shellcheck disable=SC2016  # GraphQL variables use $ inside single quotes on purpose
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: review-threads.sh <command> [args]

  list <pr> [--all]                 unresolved inline threads (--all includes resolved) with thread and comment ids
  show <comment-id>                 one inline comment with its diff hunk
  reply <comment-id> (--body <B> | --body-file <F>) [--no-attribution]
                                    reply in that comment's thread
  resolve <thread-id>               mark a thread resolved
  comment <pr> (--body <B> | --body-file <F>) [--no-attribution]
                                    top-level PR comment (not inline)

Replies and comments get an attribution line naming the agent and the account, unless --no-attribution.
EOF
}

cmd_list() {
  local n
  n="$(number_of "${1:?pr}")"
  shift || true
  local all=false
  [[ "${1:-}" == "--all" ]] && all=true
  gql -F owner="$OWNER" -F repo="$REPO" -F number="$n" -f query='
    query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      reviewThreads(first:100){ pageInfo{ hasNextPage } nodes{ id isResolved isOutdated path line originalLine
        comments(first:50){ nodes{ databaseId author{ login } createdAt body } } } } } } }' |
    jq -r --argjson all "$all" '.data.repository.pullRequest.reviewThreads
      | (if .pageInfo.hasNextPage then "warning: more than 100 threads; showing the first 100\n" else empty end),
        (.nodes[] | select($all or (.isResolved|not))
        | "=== thread \(.id)  \(.path):\(.line // .originalLine)  resolved=\(.isResolved) outdated=\(.isOutdated)",
          (.comments.nodes[] | "  [comment \(.databaseId)] @\(.author.login) \(.createdAt[:10])\n\(.body | split("\n") | map("      " + .) | join("\n"))"), "")'
}

cmd_show() {
  local id="${1:?comment-id}"
  gh api "repos/$REPO_SLUG/pulls/comments/$id" --jq '"@\(.user.login) \(.path):\(.line // .original_line)  in_reply_to=\(.in_reply_to_id // "-")\n\(.html_url)\n--- hunk\n\(.diff_hunk)\n--- body\n\(.body)"'
}

parse_body_opts() {
  BODY=""
  BODY_FILE=""
  ATTRIB=true
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --body)
      BODY="$2"
      shift
      ;;
    --body-file)
      BODY_FILE="$2"
      shift
      ;;
    --no-attribution) ATTRIB=false ;;
    *) die "unknown option: $1" ;;
    esac
    shift
  done
  [[ -n "$BODY" || -n "$BODY_FILE" ]] || die "--body or --body-file is required"
  TEXT="$(read_body "$BODY" "$BODY_FILE")"
  $ATTRIB && TEXT="$(attribution)$TEXT"
}

cmd_reply() {
  local id="${1:?comment-id}"
  shift
  parse_body_opts "$@"
  gh api -X POST "repos/$REPO_SLUG/pulls/comments/$id/replies" -f body="$TEXT" --jq .html_url
}

cmd_resolve() {
  local tid="${1:?thread-id}"
  gql -F t="$tid" -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ id isResolved } } }' \
    --jq '.data.resolveReviewThread.thread | "\(.id) resolved=\(.isResolved)"'
}

cmd_comment() {
  local n
  n="$(number_of "${1:?pr}")"
  shift
  parse_body_opts "$@"
  gh pr comment "$n" --repo "$REPO_SLUG" --body "$TEXT"
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
reply)
  shift
  cmd_reply "$@"
  ;;
resolve)
  shift
  cmd_resolve "$@"
  ;;
comment)
  shift
  cmd_comment "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
