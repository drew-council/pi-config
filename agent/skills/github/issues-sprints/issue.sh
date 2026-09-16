#!/usr/bin/env bash
# Issue operations that plain `gh issue` cannot do: issue types, parent/sub-issues,
# and creating an issue from a .github/ISSUE_TEMPLATE form without the browser.
# shellcheck disable=SC2016  # GraphQL variables use $ inside single quotes on purpose
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: issue.sh <command> [args]

  templates                        the issue forms in .github/ISSUE_TEMPLATE with their type and labels
  template <form>                  body headings for a form (bug, chore, feature, epic, ops_request)
  new --template <form> --title <T> (--body-file <F> | --body <B>)
      [--type <Type>] [--assignee <login|@me>] [--label <L>]... [--parent <N>] [--sprint current|next|TITLE]
                                   create an issue; type and labels come from the form unless overridden
  type <issue> <Type>              set the issue type (Bug, Task, Feature, Epic, Meta, Security)
  parent <issue> <parent>          make <issue> a sub-issue of <parent>
  subs <issue>                     list sub-issues
  show <issue>                     type, parent, labels, assignees, board fields

Options: --dry-run prints mutations instead of running them.
EOF
}

DRY_RUN=false
ARGS=()
for a in "$@"; do
  case "$a" in
  --dry-run) DRY_RUN=true ;;
  *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

FORMS="$(repo_root)/.github/ISSUE_TEMPLATE"

need_forms() {
  [[ -d "$FORMS" ]] || die "cannot find .github/ISSUE_TEMPLATE; run this from a $REPO_SLUG checkout"
}

form_file() {
  need_forms
  local f="$FORMS/${1%.yml}.yml"
  [[ -f "$f" ]] || die "no form '$1'; forms: $(for y in "$FORMS"/*.yml; do basename "$y" .yml; done | tr '\n' ' ')"
  printf '%s' "$f"
}

# The forms are flat YAML: top-level `type:` and `labels:`, and one `label:` per body field.
form_type() { awk '/^type:/{sub(/^type:[ ]*/,""); print}' "$1"; }
form_labels() { awk '/^labels:/{gsub(/^labels:[ ]*\[|\]$|'"'"'|"/,""); gsub(/,[ ]*/,"\n"); print}' "$1" | sed '/^$/d'; }
form_headings() {
  awk '
    /^  - type:/ { kind=$3 }
    /^      label:/ { sub(/^      label:[ ]*/,""); printf "### %s\n\n%s\n\n", $0, (kind=="dropdown" ? "<one of the options below>" : "<...>") }
    /^        - / && kind=="dropdown" { sub(/^        - /,""); print "  - " $0 }
  ' "$1"
}

cmd_templates() {
  need_forms
  local f
  for f in "$FORMS"/*.yml; do
    printf '%s\ttype=%s\tlabels=%s\n' "$(basename "$f" .yml)" "$(form_type "$f")" "$(form_labels "$f" | paste -sd, -)"
  done
}

cmd_template() {
  local f
  f="$(form_file "${1:?form}")"
  form_headings "$f"
}

type_id() {
  local name="$1" id
  id="$(gql -F org="$OWNER" -f query='query($org:String!){ organization(login:$org){ issueTypes(first:20){ nodes{ id name } } } }' |
    jq -r --arg n "$name" '.data.organization.issueTypes.nodes[] | select(.name==$n) | .id')"
  [[ -n "$id" ]] || die "no issue type '$name'"
  printf '%s' "$id"
}

issue_node_id() {
  gql -F owner="$OWNER" -F repo="$REPO" -F number="$1" -f query='query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){ id } } }' --jq '.data.repository.issue.id'
}

cmd_type() {
  local n
  n="$(number_of "${1:?issue}")"
  local tname="${2:?type}" tid iid
  tid="$(type_id "$tname")"
  iid="$(issue_node_id "$n")"
  if $DRY_RUN; then
    echo "[dry-run] set type of #$n to $tname"
    return
  fi
  gql -F i="$iid" -F t="$tid" -f query='mutation($i:ID!,$t:ID!){ updateIssueIssueType(input:{issueId:$i,issueTypeId:$t}){ issue{ number issueType{ name } } } }' \
    --jq '.data.updateIssueIssueType.issue | "#\(.number) type=\(.issueType.name)"'
}

cmd_parent() {
  local n p sub_id
  n="$(number_of "${1:?issue}")"
  p="$(number_of "${2:?parent}")"
  sub_id="$(gh api "repos/$REPO_SLUG/issues/$n" --jq .id)"
  if $DRY_RUN; then
    echo "[dry-run] POST repos/$REPO_SLUG/issues/$p/sub_issues sub_issue_id=$sub_id"
    return
  fi
  gh api -X POST "repos/$REPO_SLUG/issues/$p/sub_issues" -F sub_issue_id="$sub_id" --jq '"#'"$n"' is now a sub-issue of #\(.number) \(.title)"'
}

cmd_subs() {
  local n
  n="$(number_of "${1:?issue}")"
  gh api --paginate "repos/$REPO_SLUG/issues/$n/sub_issues" --jq '.[] | "#\(.number)\t\(.state)\t\(.assignees | map(.login) | join(","))\t\(.title)"'
}

cmd_show() {
  local n
  n="$(number_of "${1:?issue}")"
  gql -F owner="$OWNER" -F repo="$REPO" -F number="$n" -f query='
    query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){
      number title state url issueType{ name } parent{ number title }
      assignees(first:10){ nodes{ login } } labels(first:20){ nodes{ name } }
      subIssuesSummary{ total completed } } } }' \
    --jq '.data.repository.issue | "#\(.number) \(.title)\n  state: \(.state)\n  type: \(.issueType.name // "-")\n  parent: \(if .parent then "#\(.parent.number) \(.parent.title)" else "-" end)\n  assignees: \(.assignees.nodes | map(.login) | join(",") | if .=="" then "-" else . end)\n  labels: \(.labels.nodes | map(.name) | join(",") | if .=="" then "-" else . end)\n  sub-issues: \(.subIssuesSummary.completed)/\(.subIssuesSummary.total)\n  \(.url)"'
  "$HERE/sprint.sh" show "$n" | sed 's/^/  /'
}

cmd_new() {
  local form="" type="" title="" body="" body_file="" assignee="" parent="" sprint=""
  local labels=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --template)
      form="$2"
      shift
      ;;
    --type)
      type="$2"
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
    --assignee)
      assignee="$2"
      shift
      ;;
    --label)
      labels+=("$2")
      shift
      ;;
    --parent)
      parent="$2"
      shift
      ;;
    --sprint)
      sprint="$2"
      shift
      ;;
    *) die "unknown option: $1" ;;
    esac
    shift
  done
  [[ -n "$form" && -n "$title" ]] || die "--template and --title are required"
  [[ -n "$body" || -n "$body_file" ]] || die "--body or --body-file is required (see: issue.sh template $form)"
  local f
  f="$(form_file "$form")"
  [[ -n "$type" ]] || type="$(form_type "$f")"
  type_id "$type" >/dev/null
  local l
  while IFS= read -r l; do [[ -n "$l" ]] && labels+=("$l"); done < <(form_labels "$f")
  local text
  text="$(read_body "$body" "$body_file")"
  local cmd=(gh issue create --repo "$REPO_SLUG" --title "$title" --body "$text")
  [[ -n "$assignee" ]] && cmd+=(--assignee "$assignee")
  for l in "${labels[@]+"${labels[@]}"}"; do cmd+=(--label "$l"); done
  if $DRY_RUN; then
    echo "[dry-run] ${cmd[*]}"
    echo "[dry-run] then: type=$type parent=${parent:-none} sprint=${sprint:-none}"
    return
  fi
  local url n
  url="$("${cmd[@]}")"
  n="${url##*/}"
  echo "$url"
  cmd_type "$n" "$type"
  [[ -n "$parent" ]] && cmd_parent "$n" "$parent"
  [[ -n "$sprint" ]] && "$HERE/sprint.sh" set "$n" "$sprint"
  true
}

case "${1:-}" in
templates) cmd_templates ;;
template)
  shift
  cmd_template "$@"
  ;;
new)
  shift
  cmd_new "$@"
  ;;
type)
  shift
  cmd_type "$@"
  ;;
parent)
  shift
  cmd_parent "$@"
  ;;
subs)
  shift
  cmd_subs "$@"
  ;;
show)
  shift
  cmd_show "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
