#!/usr/bin/env bash
# Discover and inspect GitHub Actions runs, jobs, failures, and logs.
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

usage() {
  cat <<EOF
usage: ci.sh <command> [args]

  list [workflow] [--limit N]  recent runs, optionally for one workflow
  latest [workflow]        most recent non-skipped run, optionally for one workflow
  checks <pr>              check rollup for a PR (gh pr checks)
  runs <pr>                workflow runs for the PR's head commit, with run ids
  jobs <run-id>            jobs in a run, with job ids and results
  failed <pr|run-id>       failed jobs, and the error lines from their logs
  log <run-id> [job-name]  full logs for a run or one job, regardless of result
  rerun <run-id> [--failed]  rerun a run, or only its failed jobs
  watch <run-id>           block until the run finishes, then print the result

Workflow can be a workflow name, id, or file name accepted by 'gh run list --workflow'.
Run ids come from 'list', 'latest', or 'runs'; job names and ids come from 'jobs'.
EOF
}

head_sha() { gh pr view "$1" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid; }

runs_for_sha() {
  gh run list --repo "$REPO_SLUG" --commit "$1" --limit 30 --json databaseId,name,status,conclusion,event,url
}

recent_runs() {
  local workflow="$1" limit="$2"
  local args=(run list --repo "$REPO_SLUG" --limit "$limit" --json "databaseId,name,status,conclusion,event,headBranch,createdAt,url")
  if [[ -n "$workflow" ]]; then args+=(--workflow "$workflow"); fi
  gh "${args[@]}"
}

format_recent_runs() {
  jq -r '.[] | (.conclusion | if . == null or . == "" then "-" else . end) as $conclusion | "\(.databaseId)\t\(.name)\t\(.status)\t\($conclusion)\t\(.event)\t\(.headBranch // "-")\t\(.createdAt)\t\(.url)"'
}

cmd_list() {
  local workflow="" limit=20
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --limit)
      [[ $# -ge 2 ]] || die "--limit requires a value"
      limit="$2"
      shift 2
      ;;
    --limit=*)
      limit="${1#*=}"
      shift
      ;;
    -*) die "unknown option for list: $1" ;;
    *)
      [[ -z "$workflow" ]] || die "list accepts at most one workflow"
      workflow="$1"
      shift
      ;;
    esac
  done
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || die "--limit must be a positive integer"
  recent_runs "$workflow" "$limit" | format_recent_runs
}

cmd_latest() {
  [[ $# -le 1 ]] || die "latest accepts at most one workflow"
  local workflow="${1:-}" runs
  # Conditional workflows such as autoformat create a skipped run for every
  # irrelevant event. Ignore those trigger records so latest identifies a run
  # that could have useful jobs or logs. 'list' still shows skipped runs.
  runs="$(recent_runs "$workflow" 100 | jq '[.[] | select(.conclusion != "skipped")][0:1]')"
  [[ "$(jq 'length' <<<"$runs")" -gt 0 ]] || die "no non-skipped workflow runs found among the most recent 100${workflow:+ for workflow $workflow}"
  format_recent_runs <<<"$runs"
}

cmd_checks() { gh pr checks "$(number_of "${1:?pr}")" --repo "$REPO_SLUG"; }

cmd_runs() {
  local n
  n="$(number_of "${1:?pr}")"
  runs_for_sha "$(head_sha "$n")" | jq -r '.[] | "\(.databaseId)\t\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.url)"'
}

failed_run() {
  local id="$1"
  echo "== run $id"
  gh run view "$id" --repo "$REPO_SLUG" --json jobs --jq '.jobs[] | select(.conclusion=="failure") | "  job \(.databaseId)  \(.name)", (.steps[] | select(.conclusion=="failure") | "    step: \(.name)")'
  echo "  -- error lines"
  # Log lines are: job<TAB>step<TAB>timestamp message. Keep the message only.
  gh run view "$id" --repo "$REPO_SLUG" --log-failed 2>/dev/null |
    cut -f3- | sed -E 's/^[0-9T:.Z-]+ //' |
    grep -E '##\[error\]|--- FAIL|^FAIL|FAILED|panic:|TIMEOUT|\bError:|^error:' |
    cut -c1-240 | sort -u | head -40 | sed 's/^/    /'
}

cmd_failed() {
  local ref="${1:?pr or run-id}"
  if [[ "$ref" =~ ^[0-9]{9,}$ ]]; then
    failed_run "$ref"
    return
  fi
  local n
  n="$(number_of "$ref")"
  local ids
  ids="$(runs_for_sha "$(head_sha "$n")" | jq -r '.[] | select(.conclusion=="failure") | .databaseId')"
  [[ -n "$ids" ]] || {
    echo "no failed runs on the head commit of #$n"
    return
  }
  for id in $ids; do failed_run "$id"; done
}

cmd_jobs() {
  local id="${1:?run-id}"
  gh run view "$id" --repo "$REPO_SLUG" --json jobs --jq '.jobs[] | "\(.databaseId)\t\(.name)\t\(.status)\t\(.conclusion // "-")\t\(.url)"'
}

cmd_log() {
  local id="${1:?run-id}" job="${2:-}"
  [[ $# -le 2 ]] || die "log accepts a run id and optional job name"
  if [[ -n "$job" ]]; then
    local jid
    jid="$(gh run view "$id" --repo "$REPO_SLUG" --json jobs | jq -r --arg j "$job" '.jobs[] | select(.name==$j) | .databaseId')"
    [[ -n "$jid" ]] || die "no job named '$job' in run $id; use 'ci.sh jobs $id' to list job names"
    gh run view "$id" --repo "$REPO_SLUG" --job "$jid" --log
  else
    gh run view "$id" --repo "$REPO_SLUG" --log
  fi
}

cmd_rerun() {
  local id="${1:?run-id}"
  if [[ "${2:-}" == "--failed" ]]; then gh run rerun "$id" --repo "$REPO_SLUG" --failed; else gh run rerun "$id" --repo "$REPO_SLUG"; fi
}

cmd_watch() {
  local id="${1:?run-id}"
  gh run watch "$id" --repo "$REPO_SLUG" --exit-status --interval 30 >/dev/null 2>&1 || true
  gh run view "$id" --repo "$REPO_SLUG" --json status,conclusion,url,jobs --jq '"\(.status) \(.conclusion // "-") \(.url)", (.jobs[] | "  \(.name)\t\(.conclusion // .status)")'
}

case "${1:-}" in
list)
  shift
  cmd_list "$@"
  ;;
latest)
  shift
  cmd_latest "$@"
  ;;
checks)
  shift
  cmd_checks "$@"
  ;;
runs)
  shift
  cmd_runs "$@"
  ;;
jobs)
  shift
  cmd_jobs "$@"
  ;;
failed)
  shift
  cmd_failed "$@"
  ;;
log)
  shift
  cmd_log "$@"
  ;;
rerun)
  shift
  cmd_rerun "$@"
  ;;
watch)
  shift
  cmd_watch "$@"
  ;;
-h | --help | help | "") usage ;;
*)
  usage
  die "unknown command: $1"
  ;;
esac
