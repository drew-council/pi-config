import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseAddressReviewArgs } from "../../extensions/address-review-comments/args.js";
import {
  createReviewArtifactDirectory,
  filterGeneratedDiff,
  writeFetchArtifacts,
  writeReplyRequest,
} from "../../extensions/address-review-comments/artifacts.js";
import { createReplyRequest } from "../../extensions/address-review-comments/attribution.js";
import { REVIEW_COMMAND_NAME, REVIEW_COMMAND_USAGE } from "../../extensions/address-review-comments/constants.js";
import { queueCheckpointFeedback } from "../../extensions/address-review-comments/feedback-message.js";
import {
  fetchGitHubReviewData,
  GitHubClient,
  GitHubUsernameCache,
  ReviewThreadResolveError,
} from "../../extensions/address-review-comments/github.js";
import type { CommandExecutor, ExecResult } from "../../extensions/address-review-comments/types.js";

function success(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

test("queues checkpoint feedback as a normal steer-delivered user message", () => {
  const messages: Array<{ content: string; options: { deliverAs: "steer" } }> = [];
  const sender = {
    sendUserMessage: (content: string, options: { deliverAs: "steer" }) => messages.push({ content, options }),
  };

  assert.equal(queueCheckpointFeedback(sender, "  Please keep the existing API.\n"), "Please keep the existing API.");
  assert.deepEqual(messages, [{ content: "Please keep the existing API.", options: { deliverAs: "steer" } }]);
  assert.equal(queueCheckpointFeedback(sender, "  \n"), undefined);
  assert.equal(messages.length, 1);
});

test("appends the supervised-agent attribution to both reply actions", () => {
  const expectedComment = `Fixed.\n\n> \`pi\` agent using \`${REVIEW_COMMAND_NAME}\`, supervised by @supervisor-login`;

  assert.deepEqual(createReplyRequest("thread-1", "Fixed.", false, "supervisor-login"), {
    thread_id: "thread-1",
    comment: expectedComment,
    resolve: false,
  });
  assert.deepEqual(createReplyRequest("thread-1", "Fixed.", true, "supervisor-login"), {
    thread_id: "thread-1",
    comment: expectedComment,
    resolve: true,
  });
});

test("fetches the authenticated GitHub username only once per session cache", async () => {
  let calls = 0;
  const exec: CommandExecutor = async (_command, args) => {
    assert.deepEqual(args, ["api", "user", "--jq", ".login"]);
    calls += 1;
    return success("supervisor-login\n");
  };
  const client = new GitHubClient(exec, "/repo");
  const cache = new GitHubUsernameCache();

  assert.deepEqual(await Promise.all([cache.get(client), cache.get(client)]), ["supervisor-login", "supervisor-login"]);
  assert.equal(await cache.get(client), "supervisor-login");
  assert.equal(calls, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emptyThreadsResponse = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
});

test("starts diff and review-thread requests concurrently", async () => {
  const diff = deferred<ExecResult>();
  const threads = deferred<ExecResult>();
  const started: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      started.push("threads");
      return threads.promise;
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  const request = fetchGitHubReviewData(new GitHubClient(exec, "/repo"), "owner/repo", 42, async () => {
    started.push("diff");
    return (await diff.promise).stdout;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["diff", "threads"]);

  diff.resolve(success("diff --git a/file.ts b/file.ts\n"));
  threads.resolve(success(emptyThreadsResponse));
  assert.deepEqual(await request, { diff: "diff --git a/file.ts b/file.ts\n", threads: [], reviews: [] });
});

test("maps review-thread pagination and fetches extra comment pages", async () => {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (_command, args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("query($owner:")) {
      return success(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    { body: "", author: { __typename: "User", login: "approver" } },
                    {
                      body: "Overall looks good, but please add tests.",
                      author: { __typename: "User", login: "reviewer" },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: true,
                      path: "src/file.ts",
                      line: 12,
                      startLine: 10,
                      comments: {
                        nodes: [
                          {
                            body: "First",
                            diffHunk: "@@ -1 +1 @@",
                            author: { __typename: "User", login: "reviewer" },
                          },
                          {
                            body: "Fixed.\n\n> `pi` agent using `address-review-comments`, supervised by @supervisor",
                            diffHunk: "",
                            author: { __typename: "User", login: "author" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id:")) {
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              comments: {
                nodes: [
                  {
                    body: "Bot follow-up",
                    diffHunk: "",
                    author: { __typename: "Bot", login: "custom-review-bot" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const result = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  assert.deepEqual(result.reviews, [
    { body: "Overall looks good, but please add tests.", author: "reviewer", author_is_bot: false },
  ]);
  assert.deepEqual(result.threads, [
    {
      id: "thread-1",
      is_resolved: false,
      is_outdated: true,
      path: "src/file.ts",
      diff_hunk: "@@ -1 +1 @@",
      current_start_line: 10,
      current_end_line: 12,
      comments: [
        { body: "First", author: "reviewer", author_is_bot: false },
        { body: "Fixed.", author: "author", author_is_bot: false },
        { body: "Bot follow-up", author: "custom-review-bot", author_is_bot: true },
      ],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("-F"));
  assert.ok(calls[0]?.includes("number=42"));
  assert.ok(calls[1]?.includes("after=comments-next"));
});

test("posts a reply before resolving and returns the structured mutation payload", async () => {
  const operations: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      operations.push("reply");
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    if (query.includes("resolveReviewThread")) {
      operations.push("resolve");
      return success(
        JSON.stringify({
          data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } },
        }),
      );
    }
    throw new Error(`Unexpected mutation: ${query.slice(0, 80)}`);
  };

  const response = await new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true);
  assert.deepEqual(operations, ["reply", "resolve"]);
  assert.equal(response.reply.url, "https://github.test/comment/123");
  assert.deepEqual(response.resolved_thread, { id: "thread-1", is_resolved: true });
});

test("preserves the posted reply when the follow-up resolve mutation fails", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    return { code: 1, stdout: "", stderr: "resolution denied" };
  };

  await assert.rejects(new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true), (error: unknown) => {
    assert.ok(error instanceof ReviewThreadResolveError);
    assert.equal(error.reply.url, "https://github.test/comment/123");
    assert.match(error.message, /resolution denied/);
    return true;
  });
});

test("keeps workflow requests and fetch artifacts in one temporary directory", async () => {
  const paths = await createReviewArtifactDirectory({
    arguments: "42",
    cwd: "/repo",
    requested_pull_number: 42,
    started_at: "2026-01-01T00:00:00Z",
  });
  try {
    const response = await writeFetchArtifacts(
      paths,
      { repository: "owner/repo", selector: 42, pull_request_number: 42 },
      "diff --git a/file.ts b/file.ts\n",
      {
        repository: "owner/repo",
        github_username: "supervisor-login",
        pull_request: {
          number: 42,
          title: "Review me",
          body: "Body",
          author: "author",
          base_branch: "main",
          head_branch: "feature",
          head_sha: "abc123",
        },
        review_threads: [],
        review_summaries: [],
      },
    );
    const replyRequestPath = await writeReplyRequest(paths.directory, {
      thread_id: "PRRT/thread=1",
      comment: "Fixed.",
      resolve: true,
    });

    for (const artifactPath of [
      paths.commandRequestPath,
      paths.fetchRequestPath,
      paths.fetchResponsePath,
      paths.diffPath,
      replyRequestPath,
    ]) {
      assert.equal(path.dirname(artifactPath), paths.directory);
    }
    assert.equal(response.authored_diff_path, paths.diffPath);
    assert.equal(response.github_username, "supervisor-login");
    assert.equal(JSON.parse(await readFile(paths.fetchResponsePath, "utf8")).github_username, "supervisor-login");
    assert.deepEqual(JSON.parse(await readFile(replyRequestPath, "utf8")), {
      thread_id: "PRRT/thread=1",
      comment: "Fixed.",
      resolve: true,
    });
    assert.equal(
      (await readdir(paths.directory)).some((name) => /reply-.+-response\.json/.test(name)),
      false,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("filters generated files from the authored diff without dropping normal files", () => {
  const authored = "diff --git a/src/feature.ts b/src/feature.ts\n+authored\n";
  const generated = "diff --git a/web/src/api/gen/client_pb.ts b/web/src/api/gen/client_pb.ts\n+generated\n";
  assert.equal(filterGeneratedDiff(authored + generated), authored);
});

test("validates review command arguments", () => {
  assert.deepEqual(parseAddressReviewArgs(""), { ok: true, prNumber: undefined });
  assert.deepEqual(parseAddressReviewArgs("4098"), { ok: true, prNumber: 4098 });
  assert.deepEqual(parseAddressReviewArgs("--auto 4098"), {
    ok: false,
    message: `Unsupported option. Use ${REVIEW_COMMAND_USAGE}.`,
  });
  assert.deepEqual(parseAddressReviewArgs("abc"), { ok: false, message: "PR number must be a positive integer." });
});
