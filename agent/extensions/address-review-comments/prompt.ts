import { CHECKPOINT_TOOL_NAME } from "./constants.js";
import type { FetchResponse, WorkflowState } from "./types.js";

export function summarizeFetch(payload: FetchResponse): string {
  const threads = payload.review_threads;
  const outdated = threads.filter((thread) => thread.is_outdated).length;
  const authors = new Set<string>();
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (!comment.author_is_bot && comment.author) authors.add(comment.author);
    }
  }
  const reviewers = [...authors]
    .sort()
    .map((author) => `@${author}`)
    .join(", ");
  return [
    `Found ${threads.length} unresolved review thread(s) on PR #${payload.pull_request.number} (${payload.pull_request.title}).`,
    `- ${threads.length - outdated} actionable/current`,
    `- ${outdated} outdated`,
    reviewers ? `- reviewers: ${reviewers}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

const REPLY_TEMPLATES = [
  '- Code fix: "Fixed in `<file>:<line>` - <brief description of what changed and why>."',
  "- Question: explain the rationale directly and reference relevant context.",
  '- Disagreement: explain why the current approach is intentional, ending with "Let me know if you feel strongly."',
  '- Out of scope: "Good point - noted for follow-up."',
  "- Ambiguous: ask for clarification and say what was left unchanged.",
  "- Generated code: identify the source file and say it will be regenerated.",
  '- Outdated: "This was addressed in <commit hash or description of subsequent change>."',
].join("\n");

export function makeAgentPrompt(state: WorkflowState, summary: string): string {
  return `# Address PR Review Comments

You are addressing PR review comments in manual interactive mode. The extension has already fetched the review context with the GitHub CLI.

Repository root: \`${state.repoRoot}\`
GitHub supervisor: @${state.githubUsername}
Workflow artifact directory: \`${state.artifactDirectory}\`
Fetch request JSON: \`${state.fetchRequestPath}\`
Fetch response JSON: \`${state.fetchResponsePath}\`
Authored diff: \`${state.diffPath}\`
Starting commit: \`${state.startCommitShort}\` (compare against this to track overall review changes)

${summary}

## Critical rules

- Treat the fetch response JSON as the source of truth. Inspect it with \`read\` or other read-only tools as needed; do not refetch review data.
- Summarize the unresolved review threads, then proceed immediately. Do not ask whether to proceed.
- Process review threads one at a time until each is resolved, posted, skipped, flagged, or the user selects abort.
- Never fix unrelated review issues together. Comments about the same issue/fix may be grouped.
- \`review_summaries\` in the fetch JSON holds each reviewer's top-level review comment. There is no checkpoint or reply for these, but any actionable feedback in them must still be addressed: fold it into the related thread when one exists, otherwise make the change directly and mention it in your final summary.
- Never run GitHub review-thread mutations or legacy review-comment commands yourself.
- For every reply decision, including outdated threads, call \`${CHECKPOINT_TOOL_NAME}\`. The tool owns human approval, posting, and resolution.
- A reply is submitted only when \`${CHECKPOINT_TOOL_NAME}\` returns \`resolve\` or \`post\` with the structured GitHub response.
- After \`edit\`, incorporate the user's instructions and recreate the checkpoint for the same thread.
- After \`feedback\`, address the feedback in the code and/or draft, then recreate the checkpoint.
- After \`skip\`, revert every code change made for that thread, post nothing, track it as skipped, and continue.
- After \`abort\`, stop processing and summarize the current state.
- Leave your changes unstaged. Never commit. The user may commit while you work, so HEAD may advance.
- Draft only the substantive reply. Do not add attribution yourself; the checkpoint tool appends the standardized supervised-agent footer to every posted reply.
- Never add any other AI attribution or co-authorship.

## Reply templates

${REPLY_TEMPLATES}

Keep replies concise and adapt the template to the comment.

## Workflow

1. Inspect the fetch JSON and authored diff to list thread ids, locations, authors, full conversations, outdated status, diff hunks, and top-level review comments.
2. Present a concise summary.
3. For each thread:
   - Show reviewer, location, diff hunk, and full conversation.
   - Read the current file around the relevant code; if line numbers shifted, use diff context to locate it.
   - Categorize it as a code change, question, disagreement, out-of-scope note, ambiguous request, generated-code issue, or outdated concern.
   - For outdated threads, verify the concern truly no longer applies before drafting an outdated reply.
   - Make the appropriate code change when needed.
   - Draft a concise reply.
   - Call \`${CHECKPOINT_TOOL_NAME}\` with the thread id, location, checkpoint summary/diff, and exact draft reply.
4. Address any remaining actionable top-level review feedback that no thread covered.
5. Summarize addressed, skipped, and flagged threads, plus any top-level feedback handled directly.`;
}
