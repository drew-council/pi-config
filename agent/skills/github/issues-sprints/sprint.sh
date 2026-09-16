#!/usr/bin/env bash
# Sprint and board operations on the Sheer project (org project 9).
#
# The board is a ProjectV2. Sprints are iterations on its "Sprint" field.
# Issues are put in a sprint by adding them to the board and setting that field.
# shellcheck disable=SC2016  # GraphQL variables use $ inside single quotes on purpose
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: sprint.sh <command> [args]

  list                              sprints with ids and dates; current one marked
  current                           title and id of the sprint running today
  show <issue>                      board fields for an issue (Sprint, Status, Priority, Timeframe)
  set <issue> [current|next|TITLE]  put an issue in a sprint (default current); adds it to the board if needed
  status <issue> <Status>           set Status (Triage, Scoping, Ready, In Progress, In Review, Done, Blocked, Parked)
  field <issue> <Field> <Option>    set any single-select field (Priority: High/Med/Low; Timeframe: Now/Next/Later)
  issues [current|next|TITLE] [--mine] [--status S]
                                    issues in a sprint (default current)

Options: --dry-run prints the mutation instead of running it.
Needs the 'project' token scope: gh auth refresh -s project
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

# Project id, Sprint field id, and every iteration as JSON.
project_json() {
  gql -F org="$OWNER" -F number="$PROJECT_NUMBER" -F field="$SPRINT_FIELD" -f query='
    query($org:String!,$number:Int!,$field:String!){
      organization(login:$org){ projectV2(number:$number){
        id title
        field(name:$field){ ... on ProjectV2IterationField { id
          configuration{
            iterations{ id title startDate duration }
            completedIterations{ id title startDate duration } } } } } } }' \
    --jq '.data.organization.projectV2'
}

# Iterations annotated with .state = completed|current|upcoming, oldest first.
iterations() {
  project_json | jq '
    def starts: (.startDate|strptime("%Y-%m-%d")|mktime);
    def ends: starts + (.duration*86400);
    (.field.configuration.completedIterations | map(. + {state:"completed"}))
    + (.field.configuration.iterations | map(. + {state: (if starts <= now and now < ends then "current" else "upcoming" end)}))
    | sort_by(.startDate)'
}

resolve_iteration() {
  local which="${1:-current}"
  local its
  its="$(iterations)"
  case "$which" in
  current) jq -r '.[] | select(.state=="current") | .id' <<<"$its" ;;
  next) jq -r '[.[] | select(.state=="upcoming")][0].id // empty' <<<"$its" ;;
  *) jq -r --arg t "$which" '.[] | select(.title==$t) | .id' <<<"$its" ;;
  esac
}

# Board item for an issue on this project, or empty.
board_item() {
  local n="$1"
  gql -F owner="$OWNER" -F repo="$REPO" -F number="$n" -f query='
    query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){ issue(number:$number){ id
        projectItems(first:20, includeArchived:true){ nodes{ id project{ number }
          fieldValues(first:30){ nodes{
            ... on ProjectV2ItemFieldIterationValue { field{ ... on ProjectV2IterationField { name } } title iterationId }
            ... on ProjectV2ItemFieldSingleSelectValue { field{ ... on ProjectV2SingleSelectField { name } } name } } } } } } } }' 2>/dev/null |
    jq --argjson p "$PROJECT_NUMBER" '.data.repository.issue as $i
      | if $i == null then error("issue not found") else . end
      | ($i.projectItems.nodes[] | select(.project.number==$p)) // null
      | if . == null then {issueId:$i.id, itemId:null, fields:{}}
        else {issueId:$i.id, itemId:.id,
              fields: ([.fieldValues.nodes[] | select(.field!=null) | {key:.field.name, value:(.title // .name)}] | from_entries)} end' ||
    die "issue #$n not found"
}

ensure_on_board() {
  local n="$1" item
  item="$(board_item "$n" | jq -r '.itemId // empty')"
  if [[ -z "$item" ]]; then
    if $DRY_RUN; then
      echo "[dry-run] gh project item-add $PROJECT_NUMBER --owner $OWNER --url https://github.com/$REPO_SLUG/issues/$n" >&2
      printf 'DRY_ITEM'
      return
    fi
    item="$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "https://github.com/$REPO_SLUG/issues/$n" --format json | jq -r .id)"
    echo "added #$n to the board" >&2
  fi
  printf '%s' "$item"
}

cmd_list() {
  iterations | jq -r '.[] | "\(if .state=="current" then "*" else " " end) \(.id)  \(.title)\t\(.startDate)  \(.duration)d  \(.state)"'
}

cmd_current() {
  iterations | jq -r '.[] | select(.state=="current") | "\(.title)\t\(.id)\tstarts \(.startDate)"'
}

cmd_show() {
  local n
  n="$(number_of "${1:?issue}")"
  board_item "$n" | jq -r 'if .itemId==null then "#'"$n"' is not on the board"
    else "#'"$n"'  item=\(.itemId)", (.fields | to_entries[] | "  \(.key): \(.value)") end'
}

cmd_set() {
  local n
  n="$(number_of "${1:?issue}")"
  local which="${2:-current}"
  local pj pid fid iid item
  pj="$(project_json)"
  pid="$(jq -r .id <<<"$pj")"
  fid="$(jq -r .field.id <<<"$pj")"
  iid="$(resolve_iteration "$which")"
  [[ -n "$iid" ]] || die "no sprint matches '$which' (run: sprint.sh list)"
  item="$(ensure_on_board "$n")"
  local cmd=(gh project item-edit --project-id "$pid" --id "$item" --field-id "$fid" --iteration-id "$iid")
  if $DRY_RUN; then
    echo "[dry-run] ${cmd[*]}"
    return
  fi
  "${cmd[@]}" >/dev/null
  cmd_show "$n"
}

cmd_field() {
  local n
  n="$(number_of "${1:?issue}")"
  local field="${2:?field}" option="${3:?option}"
  local pid fjson fid oid item
  pid="$(project_json | jq -r .id)"
  fjson="$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json | jq --arg f "$field" '.fields[] | select(.name==$f)')"
  [[ -n "$fjson" ]] || die "no field named '$field'"
  fid="$(jq -r .id <<<"$fjson")"
  oid="$(jq -r --arg o "$option" '.options[]? | select(.name==$o) | .id' <<<"$fjson")"
  [[ -n "$oid" ]] || die "field '$field' has no option '$option'; options: $(jq -r '[.options[]?.name] | join(", ")' <<<"$fjson")"
  item="$(ensure_on_board "$n")"
  local cmd=(gh project item-edit --project-id "$pid" --id "$item" --field-id "$fid" --single-select-option-id "$oid")
  if $DRY_RUN; then
    echo "[dry-run] ${cmd[*]}"
    return
  fi
  "${cmd[@]}" >/dev/null
  cmd_show "$n"
}

cmd_status() { cmd_field "${1:?issue}" Status "${2:?status}"; }

cmd_issues() {
  local which="current" mine=false status=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --mine) mine=true ;;
    --status)
      status="$2"
      shift
      ;;
    *) which="$1" ;;
    esac
    shift
  done
  local title
  case "$which" in
  current) title="$(iterations | jq -r '.[] | select(.state=="current") | .title')" ;;
  next) title="$(iterations | jq -r '[.[] | select(.state=="upcoming")][0].title // empty')" ;;
  *) title="$which" ;;
  esac
  [[ -n "$title" ]] || die "no sprint matches '$which'"
  local login=""
  $mine && login="$(me)"
  echo "== $title" >&2
  gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 2000 --format json |
    jq -r --arg t "$title" --arg me "$login" --arg s "$status" '
      .items[] | select(.sprint.title==$t)
      | select($me=="" or ((.assignees // []) | index($me)))
      | select($s=="" or .status==$s)
      | "#\(.content.number)\t\(.status // "-")\t\(.assignees // [] | join(","))\t\(.title)"'
}

case "${1:-}" in
list) cmd_list ;;
current) cmd_current ;;
show)
  shift
  cmd_show "$@"
  ;;
set)
  shift
  cmd_set "$@"
  ;;
status)
  shift
  cmd_status "$@"
  ;;
field)
  shift
  cmd_field "$@"
  ;;
issues)
  shift
  cmd_issues "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
