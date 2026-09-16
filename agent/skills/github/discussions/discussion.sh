#!/usr/bin/env bash
# GitHub Discussions on sheerhealth/sheer. `gh` has no discussion subcommand, so this wraps GraphQL.
# shellcheck disable=SC2016  # GraphQL variables use $ inside single quotes on purpose
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: discussion.sh <command> [args]

  categories                          category names, slugs, and ids
  list [--category <C>] [--limit <N>] newest discussions (default 30)
  search <words>... [--category <C>]  full-text search (title and body)
  show <number> [--no-comments]       body and comments as markdown
  new --category <C> --title <T> (--body-file <F> | --body <B>)
                                      create a discussion; prints its URL

Category names are case-sensitive: Specs, Decisions, Ideas, Q&A, General, Announcements, Learning, Postmortem, Retrospectives, Show and tell, Polls.
EOF
}

categories_json() {
  gql -F owner="$OWNER" -F repo="$REPO" -f query='query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ id discussionCategories(first:30){ nodes{ id name slug } } } }' --jq '.data.repository'
}

category_id() {
  local id
  id="$(categories_json | jq -r --arg n "$1" '.discussionCategories.nodes[] | select(.name==$n or .slug==$n) | .id')"
  [[ -n "$id" ]] || die "no category '$1' (run: discussion.sh categories)"
  printf '%s' "$id"
}

cmd_categories() {
  categories_json | jq -r '.discussionCategories.nodes[] | "\(.name)\t\(.slug)\t\(.id)"'
}

cmd_list() {
  local cat="" limit=30
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --category)
      cat="$2"
      shift
      ;;
    --limit)
      limit="$2"
      shift
      ;;
    *) die "unknown option: $1" ;;
    esac
    shift
  done
  local cid=""
  [[ -n "$cat" ]] && cid="$(category_id "$cat")"
  gql -F owner="$OWNER" -F repo="$REPO" -F n="$limit" -F cid="$cid" -f query='
    query($owner:String!,$repo:String!,$n:Int!,$cid:ID){ repository(owner:$owner,name:$repo){
      discussions(first:$n, categoryId:$cid, orderBy:{field:CREATED_AT, direction:DESC}){ nodes{
        number title createdAt author{ login } category{ name } comments{ totalCount } } } } }' \
    --jq '.data.repository.discussions.nodes[] | "#\(.number)\t\(.createdAt[:10])\t[\(.category.name)]\t@\(.author.login)\t\(.title)\t(\(.comments.totalCount) comments)"'
}

cmd_search() {
  local cat="" words=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --category)
      cat="$2"
      shift
      ;;
    *) words+=("$1") ;;
    esac
    shift
  done
  [[ ${#words[@]} -gt 0 ]] || die "search needs words"
  local q="repo:$REPO_SLUG ${words[*]}"
  [[ -n "$cat" ]] && q="$q category:\"$cat\""
  gql -F q="$q" -f query='query($q:String!){ search(query:$q, type:DISCUSSION, first:30){ discussionCount nodes{ ... on Discussion { number title createdAt author{ login } category{ name } } } } }' \
    --jq '.data.search | "\(.discussionCount) results", (.nodes[] | "#\(.number)\t\(.createdAt[:10])\t[\(.category.name)]\t@\(.author.login)\t\(.title)")'
}

cmd_show() {
  local n
  n="$(number_of "${1:?number}")"
  shift || true
  local comments=true
  [[ "${1:-}" == "--no-comments" ]] && comments=false
  gql -F owner="$OWNER" -F repo="$REPO" -F number="$n" -f query='
    query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ discussion(number:$number){
      title url createdAt author{ login } category{ name } body
      comments(first:50){ nodes{ author{ login } createdAt body
        replies(first:30){ nodes{ author{ login } createdAt body } } } } } } }' |
    jq -r --argjson c "$comments" '.data.repository.discussion
      | "# \(.title)\n\n[\(.category.name)] @\(.author.login) \(.createdAt[:10])  \(.url)\n\n\(.body)\n",
        (if $c then (.comments.nodes[] | "\n---\n\n## @\(.author.login) \(.createdAt[:10])\n\n\(.body)\n",
          (.replies.nodes[] | "\n> **@\(.author.login) \(.createdAt[:10])**\n\(.body | split("\n") | map("> " + .) | join("\n"))\n")) else empty end)'
}

cmd_new() {
  local cat="" title="" body="" body_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --category)
      cat="$2"
      shift
      ;;
    --title)
      title="$2"
      shift
      ;;
    --body)
      body="$2"
      shift
      ;;
    --body-file)
      body_file="$2"
      shift
      ;;
    *) die "unknown option: $1" ;;
    esac
    shift
  done
  [[ -n "$cat" && -n "$title" ]] || die "--category and --title are required"
  [[ -n "$body" || -n "$body_file" ]] || die "--body or --body-file is required"
  local rid cid text
  rid="$(categories_json | jq -r .id)"
  cid="$(category_id "$cat")"
  text="$(read_body "$body" "$body_file")"
  gql -F r="$rid" -F c="$cid" -F t="$title" -F b="$text" -f query='mutation($r:ID!,$c:ID!,$t:String!,$b:String!){ createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){ discussion{ number url } } }' \
    --jq '.data.createDiscussion.discussion | "#\(.number) \(.url)"'
}

case "${1:-}" in
categories) cmd_categories ;;
list)
  shift
  cmd_list "$@"
  ;;
search)
  shift
  cmd_search "$@"
  ;;
show)
  shift
  cmd_show "$@"
  ;;
new)
  shift
  cmd_new "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
