import { stripReplyAttribution } from "./attribution.js";
import type {
  CommandExecutor,
  PullRequestRecord,
  PullRequestStack,
  PullRequestStackEntry,
  ReplyResponse,
  ResolvedReviewThread,
  ReviewComment,
  ReviewThread,
  ReviewThreadReply,
  StackEntryStatus,
} from "./types.js";

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        nodes {
          body
          author { __typename login }
        }
      }
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 100) {
            nodes {
              body
              diffHunk
              author { __typename login }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const STACK_QUERY = `
query StackOverview($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      stack {
        number
        size
        baseRefName
        entries(first: 100, after: $after) {
          nodes {
            position
            pullRequest {
              number
              title
              state
              isDraft
              headRefName
              baseRefName
              url
              mergeQueueEntry { id }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        nodes {
          body
          diffHunk
          author { __typename login }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ADD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: {pullRequestReviewThreadId: $threadId, body: $body}
  ) {
    comment {
      id
      databaseId
      url
      body
      createdAt
      author { login }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;

const BOT_LOGINS = new Set([
  "greptile-apps",
  "cursor",
  "amazon-inspector-n-virginia",
  "amazon-inspector-oregon",
  "dependabot[bot]",
  "dirac-bot",
  "app/dependabot",
  "app/dirac-bot",
]);

interface GraphqlAuthor {
  __typename?: string;
  login?: string;
}

interface GraphqlComment {
  body?: string;
  diffHunk?: string;
  author?: GraphqlAuthor | null;
}

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface CommentConnection {
  nodes?: GraphqlComment[];
  pageInfo?: PageInfo;
}

interface GraphqlThread {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  startLine?: number | null;
  comments?: CommentConnection;
}

interface GraphqlStackEntry {
  position?: number;
  pullRequest?: {
    number?: number;
    title?: string;
    state?: string;
    isDraft?: boolean;
    headRefName?: string;
    baseRefName?: string;
    url?: string;
    mergeQueueEntry?: { id?: string } | null;
  } | null;
}

interface GraphqlStack {
  number?: number;
  size?: number;
  baseRefName?: string;
  entries?: { nodes?: GraphqlStackEntry[]; pageInfo?: PageInfo };
}

interface PullView {
  number?: number;
  title?: string;
  body?: string;
  author?: { login?: string } | null;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
}

function errorDetail(result: ExecResultLike): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with status ${result.code}`;
}

interface ExecResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

function parseJson<T>(raw: string, operation: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`Invalid GitHub repository slug: ${repository}`);
  return { owner, name };
}

function isBot(author: GraphqlAuthor | null | undefined): boolean {
  const login = author?.login ?? "";
  return author?.__typename === "Bot" || BOT_LOGINS.has(login) || login.toLowerCase().includes("[bot]");
}

function stackEntryStatus(pull: NonNullable<GraphqlStackEntry["pullRequest"]>): StackEntryStatus {
  if (pull.state === "MERGED") return "merged";
  if (pull.state === "CLOSED") return "closed";
  if (pull.mergeQueueEntry?.id) return "queued";
  if (pull.isDraft) return "draft";
  return "open";
}

function mapStackEntry(entry: GraphqlStackEntry, currentPullNumber: number): PullRequestStackEntry {
  const pull = entry.pullRequest;
  if (!pull?.number || entry.position === undefined) {
    throw new Error("GitHub returned a stack entry without a pull request.");
  }
  return {
    position: entry.position,
    number: pull.number,
    title: pull.title ?? "",
    status: stackEntryStatus(pull),
    head_branch: pull.headRefName ?? "",
    base_branch: pull.baseRefName ?? "",
    url: pull.url ?? "",
    is_current: pull.number === currentPullNumber,
  };
}

function mapComment(comment: GraphqlComment): ReviewComment {
  return {
    body: stripReplyAttribution(comment.body ?? ""),
    author: comment.author?.login ?? null,
    author_is_bot: isBot(comment.author),
  };
}

export class ReviewThreadResolveError extends Error {
  constructor(
    readonly reply: ReviewThreadReply,
    readonly resolveError: unknown,
  ) {
    super(
      `Reply was posted at ${reply.url}, but resolving the thread failed: ${
        resolveError instanceof Error ? resolveError.message : String(resolveError)
      }`,
    );
    this.name = "ReviewThreadResolveError";
  }
}

export class GitHubClient {
  constructor(
    private readonly exec: CommandExecutor,
    private readonly cwd: string,
  ) {}

  private async gh(args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<string> {
    const result = await this.exec("gh", args, {
      cwd: this.cwd,
      signal: options?.signal,
      timeout: options?.timeout ?? 120_000,
    });
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${errorDetail(result)}`);
    return result.stdout;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, string | number | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) continue;
      args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
    }
    const envelope = parseJson<{ data?: T }>(await this.gh(args, options), "GitHub GraphQL request");
    if (!envelope.data) throw new Error("GitHub GraphQL response did not include data.");
    return envelope.data;
  }

  async getAuthenticatedUsername(signal?: AbortSignal): Promise<string> {
    const username = (await this.gh(["api", "user", "--jq", ".login"], { signal })).trim();
    if (!username) throw new Error("Unable to determine the authenticated GitHub username.");
    return username;
  }

  async detectRepository(signal?: AbortSignal): Promise<string> {
    const repository = (
      await this.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
        signal,
      })
    ).trim();
    if (!repository) throw new Error("Unable to detect the GitHub repository from the current checkout.");
    return repository;
  }

  async getPullRequest(
    repository: string,
    selector: number | string,
    signal?: AbortSignal,
  ): Promise<PullRequestRecord> {
    const fields = "number,title,body,author,baseRefName,headRefName,headRefOid";
    const raw = await this.gh(["pr", "view", String(selector), "--repo", repository, "--json", fields], { signal });
    const pull = parseJson<PullView>(raw, "gh pr view");
    if (!pull.number || !pull.title || !pull.baseRefName || !pull.headRefName || !pull.headRefOid) {
      throw new Error("gh pr view returned incomplete pull request metadata.");
    }
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body || "EMPTY",
      author: pull.author?.login ?? null,
      base_branch: pull.baseRefName,
      head_branch: pull.headRefName,
      head_sha: pull.headRefOid,
    };
  }

  /** Returns null when the PR is not part of a GitHub stack. */
  async fetchPullRequestStack(
    repository: string,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestStack | null> {
    const { owner, name } = splitRepository(repository);
    let stack: GraphqlStack | null | undefined;
    const entries: PullRequestStackEntry[] = [];
    let after: string | undefined;
    do {
      const response = await this.graphql<{
        repository?: { pullRequest?: { stack?: GraphqlStack | null } | null } | null;
      }>(STACK_QUERY, { owner, name, number: pullNumber, after }, { signal });
      const pull = response.repository?.pullRequest;
      if (!pull) throw new Error(`PR #${pullNumber} was not found in ${repository}.`);
      stack = pull.stack;
      if (!stack) return null;
      entries.push(...(stack.entries?.nodes ?? []).map((entry) => mapStackEntry(entry, pullNumber)));
      after = stack.entries?.pageInfo?.hasNextPage ? (stack.entries.pageInfo.endCursor ?? undefined) : undefined;
    } while (after);
    if (stack.number === undefined || !stack.baseRefName) {
      throw new Error("GitHub returned incomplete stack metadata.");
    }
    entries.sort((a, b) => a.position - b.position);
    return { number: stack.number, trunk: stack.baseRefName, size: stack.size ?? entries.length, entries };
  }

  private async fetchAdditionalComments(
    threadId: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<ReviewComment[]> {
    const comments: ReviewComment[] = [];
    let after: string | undefined = cursor;
    while (after) {
      const response = await this.graphql<{
        node?: { __typename?: string; comments?: CommentConnection } | null;
      }>(THREAD_COMMENTS_QUERY, { id: threadId, after }, { signal });
      if (response.node?.__typename !== "PullRequestReviewThread") {
        throw new Error(`Unable to fetch additional comments for review thread ${threadId}.`);
      }
      const connection = response.node.comments;
      comments.push(...(connection?.nodes ?? []).map(mapComment));
      after = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? undefined) : undefined;
    }
    return comments;
  }

  private async mapThread(node: GraphqlThread, signal?: AbortSignal): Promise<ReviewThread> {
    if (!node.id) throw new Error("GitHub returned a review thread without an id.");
    const initialComments = node.comments?.nodes ?? [];
    const comments = initialComments.map(mapComment);
    const nextCursor = node.comments?.pageInfo?.hasNextPage ? node.comments.pageInfo.endCursor : undefined;
    if (nextCursor) comments.push(...(await this.fetchAdditionalComments(node.id, nextCursor, signal)));
    const startLine = node.startLine ?? node.line ?? null;
    return {
      id: node.id,
      is_resolved: Boolean(node.isResolved),
      is_outdated: Boolean(node.isOutdated),
      path: node.path ?? "",
      diff_hunk: initialComments[0]?.diffHunk ?? "",
      current_start_line: startLine,
      current_end_line: node.line ?? startLine,
      comments,
    };
  }

  async fetchReviewThreads(
    repository: string,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<{ threads: ReviewThread[]; reviews: ReviewComment[] }> {
    const { owner, name } = splitRepository(repository);
    const threads: ReviewThread[] = [];
    let reviews: ReviewComment[] = [];
    let after: string | undefined;
    do {
      const response = await this.graphql<{
        repository?: {
          pullRequest?: {
            reviews?: { nodes?: GraphqlComment[] };
            reviewThreads?: { nodes?: GraphqlThread[]; pageInfo?: PageInfo };
          } | null;
        } | null;
      }>(THREADS_QUERY, { owner, name, number: pullNumber, after }, { signal });
      const connection = response.repository?.pullRequest?.reviewThreads;
      if (!connection) throw new Error(`PR #${pullNumber} was not found in ${repository}.`);
      reviews = (response.repository?.pullRequest?.reviews?.nodes ?? [])
        .map(mapComment)
        .filter((review) => review.body.trim() !== "");
      // Extra comment pages are fetched concurrently across threads in this page.
      threads.push(...(await Promise.all((connection.nodes ?? []).map((node) => this.mapThread(node, signal)))));
      after = connection.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? undefined) : undefined;
    } while (after);
    return { threads, reviews };
  }

  async replyToThread(threadId: string, body: string, signal?: AbortSignal): Promise<ReviewThreadReply> {
    const response = await this.graphql<{
      addPullRequestReviewThreadReply?: {
        comment?: {
          id?: string;
          databaseId?: number;
          url?: string;
          body?: string;
          createdAt?: string;
          author?: { login?: string } | null;
        } | null;
      };
    }>(ADD_REPLY_MUTATION, { threadId, body }, { signal });
    const comment = response.addPullRequestReviewThreadReply?.comment;
    if (!comment?.id || !comment.url || !comment.createdAt) {
      throw new Error(`GitHub did not return a reply payload for review thread ${threadId}.`);
    }
    return {
      id: comment.id,
      database_id: comment.databaseId ?? 0,
      url: comment.url,
      body: comment.body ?? body,
      created_at: comment.createdAt,
      author: comment.author?.login ?? null,
    };
  }

  async resolveThread(threadId: string, signal?: AbortSignal): Promise<ResolvedReviewThread> {
    const response = await this.graphql<{
      resolveReviewThread?: { thread?: { id?: string; isResolved?: boolean } | null };
    }>(RESOLVE_THREAD_MUTATION, { threadId }, { signal });
    const thread = response.resolveReviewThread?.thread;
    if (!thread?.id) throw new Error(`GitHub did not return a resolve payload for review thread ${threadId}.`);
    return { id: thread.id, is_resolved: Boolean(thread.isResolved) };
  }

  async submitReply(
    threadId: string,
    body: string,
    resolve: boolean,
    signal?: AbortSignal,
    onReply?: (reply: ReviewThreadReply) => void,
  ): Promise<ReplyResponse> {
    const reply = await this.replyToThread(threadId, body, signal);
    onReply?.(reply);
    if (!resolve) return { thread_id: threadId, reply, resolved_thread: null };

    try {
      const resolvedThread = await this.resolveThread(threadId, signal);
      return { thread_id: threadId, reply, resolved_thread: resolvedThread };
    } catch (error) {
      throw new ReviewThreadResolveError(reply, error);
    }
  }
}

export class GitHubUsernameCache {
  private username: string | undefined;
  private pending: Promise<string> | undefined;

  reset(username?: string): void {
    this.username = username;
    this.pending = undefined;
  }

  async get(client: GitHubClient, signal?: AbortSignal): Promise<string> {
    if (this.username) return this.username;
    this.pending ??= client.getAuthenticatedUsername(signal);
    try {
      this.username = await this.pending;
      return this.username;
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
  }
}

export interface GitHubReviewData {
  diff: string;
  threads: ReviewThread[];
  reviews: ReviewComment[];
  stack: PullRequestStack | null;
  /** Set when the stack lookup failed; the workflow continues without stack context. */
  stackError?: string;
}

export async function fetchGitHubReviewData(
  client: GitHubClient,
  repository: string,
  pullNumber: number,
  loadDiff: () => Promise<string>,
  signal?: AbortSignal,
  onComplete?: (part: "diff" | "threads" | "stack") => void,
): Promise<GitHubReviewData> {
  const [diffResult, threadsResult, stackResult] = await Promise.allSettled([
    loadDiff().then((value) => {
      onComplete?.("diff");
      return value;
    }),
    client.fetchReviewThreads(repository, pullNumber, signal).then((value) => {
      onComplete?.("threads");
      return value;
    }),
    client.fetchPullRequestStack(repository, pullNumber, signal).then((value) => {
      onComplete?.("stack");
      return value;
    }),
  ]);
  if (diffResult.status === "rejected") throw diffResult.reason;
  if (threadsResult.status === "rejected") throw threadsResult.reason;
  const data: GitHubReviewData = { diff: diffResult.value, ...threadsResult.value, stack: null };
  if (stackResult.status === "fulfilled") data.stack = stackResult.value;
  else data.stackError = stackResult.reason instanceof Error ? stackResult.reason.message : String(stackResult.reason);
  return data;
}
