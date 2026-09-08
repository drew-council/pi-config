export interface ReviewComment {
  body: string;
  author: string | null;
  author_is_bot: boolean;
}

export interface ReviewThread {
  id: string;
  is_resolved: boolean;
  is_outdated: boolean;
  path: string;
  diff_hunk: string;
  current_start_line: number | null;
  current_end_line: number | null;
  comments: ReviewComment[];
}

export interface PullRequestRecord {
  number: number;
  title: string;
  body: string;
  author: string | null;
  base_branch: string;
  head_branch: string;
  head_sha: string;
}

export type StackEntryStatus = "open" | "draft" | "queued" | "merged" | "closed";

export interface PullRequestStackEntry {
  /** 1 is closest to the trunk; higher positions are stacked on top of lower ones. */
  position: number;
  number: number;
  title: string;
  status: StackEntryStatus;
  head_branch: string;
  base_branch: string;
  url: string;
  is_current: boolean;
}

export interface PullRequestStack {
  /** Stack number shown in the GitHub stack UI and accepted by `gh stack checkout`. */
  number: number;
  trunk: string;
  size: number;
  entries: PullRequestStackEntry[];
}

export interface FetchRequest {
  repository: string;
  selector: number | string;
  pull_request_number: number;
}

export interface FetchResponse {
  repository: string;
  github_username: string;
  pull_request: PullRequestRecord;
  authored_diff_path: string;
  review_threads: ReviewThread[];
  /** Non-empty top-level review bodies. No checkpoint or reply exists for these. */
  review_summaries: ReviewComment[];
  /** Stack overview when the PR is part of a GitHub stack; null otherwise or when the lookup failed. */
  stack: PullRequestStack | null;
}

export interface ReviewThreadReply {
  id: string;
  database_id: number;
  url: string;
  body: string;
  created_at: string;
  author: string | null;
}

export interface ResolvedReviewThread {
  id: string;
  is_resolved: boolean;
}

export interface ReplyRequest {
  thread_id: string;
  comment: string;
  resolve: boolean;
}

export interface ReplyResponse {
  thread_id: string;
  reply: ReviewThreadReply;
  resolved_thread: ResolvedReviewThread | null;
}

export interface WorkflowState {
  repoRoot: string;
  repository: string;
  githubUsername: string;
  artifactDirectory: string;
  commandRequestPath: string;
  fetchRequestPath: string;
  fetchResponsePath: string;
  diffPath: string;
  startCommitShort: string;
  prNumber: number;
  startedAt: string;
  threadIds: string[];
  active: boolean;
  finishedAt?: string;
}

export interface CheckpointParams {
  threadId: string;
  location: string;
  reviewer?: string;
  checkpointMarkdown: string;
  draftReply: string;
  recommendedAction?: RecommendedAction;
}

export const CHECKPOINT_ACTIONS = [
  {
    option: "resolve",
    label: "resolve - post the draft reply and resolve the thread",
    kind: "submit",
    recommended: true,
    terminal: true,
    resolveThread: true,
  },
  {
    option: "post",
    label: "post - post the draft reply only",
    kind: "submit",
    recommended: true,
    terminal: true,
    resolveThread: false,
  },
  {
    option: "edit",
    label: "edit - provide instructions to edit the draft reply",
    kind: "revise",
    recommended: false,
    terminal: false,
    prompt: "Describe how the draft reply should be edited.",
  },
  {
    option: "feedback",
    label: "feedback - provide feedback for the agent to address, then checkpoint again",
    kind: "revise",
    recommended: false,
    terminal: false,
    prompt: "Provide feedback for the agent to address before recreating this checkpoint.",
  },
  {
    option: "skip",
    label: "skip - post nothing for this thread",
    kind: "skip",
    recommended: false,
    terminal: true,
  },
  {
    option: "abort",
    label: "abort - stop processing remaining comments",
    kind: "abort",
    recommended: false,
    terminal: true,
  },
] as const;

export type CheckpointAction = (typeof CHECKPOINT_ACTIONS)[number];
export type CheckpointOption = CheckpointAction["option"];
export type RecommendedAction = Extract<CheckpointAction, { recommended: true }>["option"];

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
