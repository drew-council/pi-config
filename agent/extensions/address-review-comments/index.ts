import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveExtensionPath } from "../shared/paths.js";
import { latestCustomEntryData } from "../shared/session-entries.js";
import { createLazyToolActivation } from "../shared/tool-activation.js";
import { parseAddressReviewArgs } from "./args.js";
import { createReviewArtifactDirectory, writeFetchArtifacts } from "./artifacts.js";
import { registerCheckpointTool } from "./checkpoint-tool.js";
import {
  CHECKPOINT_ENTRY_TYPE,
  CHECKPOINT_TOOL_NAME,
  FETCH_WIDGET_ID,
  LEGACY_SKILL_PATH,
  REVIEW_COMMAND,
  REVIEW_COMMAND_ALIAS,
  REVIEW_COMMAND_ALIAS_NAME,
  REVIEW_COMMAND_NAME,
  STATE_ENTRY_TYPE,
  STATUS_ID,
} from "./constants.js";
import { currentBranch, ensurePullCheckout, pullRequestDiff, resolveRepositoryRoot, shortHead } from "./git.js";
import { fetchGitHubReviewData, GitHubClient, GitHubUsernameCache } from "./github.js";
import { makeAgentPrompt, summarizeFetch } from "./prompt.js";
import type { FetchResponse, WorkflowState } from "./types.js";

const LEGACY_BLOCK_REASON = `The legacy ${REVIEW_COMMAND_NAME} skill is disabled. Use ${REVIEW_COMMAND} so the extension can enforce checkpoints.`;

function commandExecutor(pi: ExtensionAPI) {
  return (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) =>
    pi.exec(command, args, options);
}

class FetchProgress {
  private metadata = false;
  private checkout = false;
  private diff = false;
  private threads = false;
  private artifacts = false;

  constructor(private readonly ctx: ExtensionCommandContext) {
    this.render();
  }

  complete(step: "metadata" | "checkout" | "diff" | "threads" | "artifacts"): void {
    this[step] = true;
    this.render();
  }

  close(): void {
    this.ctx.ui.setWidget(FETCH_WIDGET_ID, undefined);
  }

  private render(): void {
    const item = (done: boolean, label: string) => (done ? `✓ ${label}` : `· ${label}`);
    const complete = [this.metadata, this.checkout, this.diff, this.threads, this.artifacts].filter(Boolean).length;
    this.ctx.ui.setStatus(STATUS_ID, this.ctx.ui.theme.fg("warning", `review:fetch ${complete}/5`));
    this.ctx.ui.setWidget(
      FETCH_WIDGET_ID,
      (_tui, theme) =>
        new Text(
          [
            theme.fg("accent", theme.bold("Fetching PR review context")),
            [
              item(this.metadata, "metadata"),
              item(this.checkout, "checkout"),
              item(this.diff, "diff"),
              item(this.threads, "threads"),
              item(this.artifacts, "artifacts"),
            ].join("  "),
          ].join("\n"),
          0,
          0,
        ),
      { placement: "aboveEditor" },
    );
  }
}

function targetsLegacySkill(toolName: string, input: unknown, cwd: string): boolean {
  const params = input as { path?: unknown; command?: unknown };
  const absoluteSkillPath = resolveExtensionPath(LEGACY_SKILL_PATH, cwd);
  if (toolName === "read") {
    const requested = typeof params.path === "string" ? params.path : "";
    return resolveExtensionPath(requested, cwd) === absoluteSkillPath;
  }
  if (toolName === "bash") {
    const command = String(params.command ?? "");
    return command.includes(LEGACY_SKILL_PATH) || command.includes(absoluteSkillPath);
  }
  return false;
}

export default function addressReviewCommentsExtension(pi: ExtensionAPI): void {
  let activeWorkflow: WorkflowState | undefined;
  let terminalThreadIds = new Set<string>();
  let setToolEnabled!: (enabled: boolean) => void;
  const githubUsernameCache = new GitHubUsernameCache();

  const updateStatus = (ctx: ExtensionContext) => {
    if (!activeWorkflow) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const remaining = activeWorkflow.threadIds.filter((id) => !terminalThreadIds.has(id)).length;
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", `review:#${activeWorkflow.prNumber} ${remaining} left`));
  };

  const finish = (ctx: ExtensionContext) => {
    if (!activeWorkflow) return;
    pi.appendEntry(STATE_ENTRY_TYPE, {
      ...activeWorkflow,
      active: false,
      finishedAt: new Date().toISOString(),
    });
    activeWorkflow = undefined;
    terminalThreadIds = new Set();
    setToolEnabled(false);
    updateStatus(ctx);
  };

  const markTerminal = (threadId: string, ctx: ExtensionContext): boolean => {
    terminalThreadIds.add(threadId);
    const complete = Boolean(activeWorkflow?.threadIds.every((candidate) => terminalThreadIds.has(candidate)));
    if (complete) finish(ctx);
    else updateStatus(ctx);
    return complete;
  };

  const checkpointTool = createLazyToolActivation(pi, CHECKPOINT_TOOL_NAME, () => {
    registerCheckpointTool(pi, {
      getWorkflow: () => activeWorkflow,
      isTerminal: (threadId) => terminalThreadIds.has(threadId),
      finish,
      markTerminal,
    });
  });
  setToolEnabled = checkpointTool.setEnabled;

  const runReviewCommand = async (args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to finish before addressing review comments.", "warning");
      return;
    }
    if (activeWorkflow) {
      ctx.ui.notify(`PR #${activeWorkflow.prNumber} already has an active review-comment workflow.`, "warning");
      return;
    }
    const parsed = parseAddressReviewArgs(args);
    if (parsed.ok === false) {
      ctx.ui.notify(parsed.message, "warning");
      return;
    }

    const startedAt = new Date().toISOString();
    const progress = new FetchProgress(ctx);
    try {
      const artifactPaths = await createReviewArtifactDirectory({
        arguments: args,
        cwd: ctx.cwd,
        requested_pull_number: parsed.prNumber ?? null,
        started_at: startedAt,
      });
      const exec = commandExecutor(pi);
      const repositoryRoot = await resolveRepositoryRoot(exec, ctx.cwd);
      const client = new GitHubClient(exec, repositoryRoot);
      const [repository, branch, githubUsername] = await Promise.all([
        client.detectRepository(),
        currentBranch(exec, repositoryRoot),
        githubUsernameCache.get(client),
      ]);
      const selector = parsed.prNumber ?? branch;
      const pull = await client.getPullRequest(repository, selector);
      progress.complete("metadata");

      const switched = await ensurePullCheckout(exec, repositoryRoot, repository, pull.number, pull.head_branch);
      if (switched) ctx.ui.notify(`Checked out PR branch ${pull.head_branch}.`, "info");
      progress.complete("checkout");

      const startCommitShort = await shortHead(exec, repositoryRoot);
      const githubData = await fetchGitHubReviewData(
        client,
        repository,
        pull.number,
        () => pullRequestDiff(exec, repositoryRoot, pull.base_branch),
        undefined,
        (part) => {
          progress.complete(part);
        },
      );
      const unresolved = githubData.threads.filter((thread) => !thread.is_resolved);
      const responseWithoutPath: Omit<FetchResponse, "authored_diff_path"> = {
        repository,
        github_username: githubUsername,
        pull_request: pull,
        review_threads: unresolved,
        review_summaries: githubData.reviews,
      };
      const response = await writeFetchArtifacts(
        artifactPaths,
        { repository, selector, pull_request_number: pull.number },
        githubData.diff,
        responseWithoutPath,
      );
      progress.complete("artifacts");

      if (unresolved.length === 0) {
        ctx.ui.notify(`PR #${pull.number} has no unresolved review comments.`, "info");
        return;
      }

      activeWorkflow = {
        repoRoot: repositoryRoot,
        repository,
        githubUsername,
        artifactDirectory: artifactPaths.directory,
        commandRequestPath: artifactPaths.commandRequestPath,
        fetchRequestPath: artifactPaths.fetchRequestPath,
        fetchResponsePath: artifactPaths.fetchResponsePath,
        diffPath: artifactPaths.diffPath,
        startCommitShort,
        prNumber: pull.number,
        startedAt,
        threadIds: unresolved.map((thread) => thread.id),
        active: true,
      };
      terminalThreadIds = new Set();
      pi.appendEntry(STATE_ENTRY_TYPE, activeWorkflow);
      setToolEnabled(true);
      updateStatus(ctx);

      const summary = summarizeFetch(response);
      ctx.ui.notify(`Fetched ${unresolved.length} unresolved thread(s) from PR #${pull.number}.`, "info");
      pi.sendUserMessage(makeAgentPrompt(activeWorkflow, summary));
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      progress.close();
      updateStatus(ctx);
    }
  };

  pi.registerCommand(REVIEW_COMMAND_NAME, {
    description: "Fetch and address GitHub PR review comments with structured human checkpoints",
    getArgumentCompletions: () => null,
    handler: runReviewCommand,
  });
  pi.registerCommand(REVIEW_COMMAND_ALIAS_NAME, {
    description: `${REVIEW_COMMAND_ALIAS} alias for ${REVIEW_COMMAND} that cannot collide with a project-local port`,
    getArgumentCompletions: () => null,
    handler: runReviewCommand,
  });

  pi.on("input", async (event, ctx) => {
    if (new RegExp(`^/skill:${REVIEW_COMMAND_NAME}(?:\\s|$)`).test(event.text.trim())) {
      ctx.ui.notify(LEGACY_BLOCK_REASON, "warning");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (activeWorkflow && targetsLegacySkill(event.toolName, event.input, ctx.cwd)) {
      return { block: true, reason: LEGACY_BLOCK_REASON };
    }
    if (event.toolName !== "bash" || !activeWorkflow) return undefined;

    const command = String((event.input as { command?: unknown }).command ?? "");
    const legacyOperation =
      /(?:^|[\s;&|])review\s+comments\s+(?:fetch|reply)\b/.test(command) ||
      (/(?:^|[\s;&|])go\s+run\b[\s\S]*cmd\/review/.test(command) && /comments\s+(?:fetch|reply)\b/.test(command));
    const directGitHubReviewOperation =
      /\bgh\s+pr\s+(?:view|diff)\b/.test(command) ||
      (/\bgh\s+api\b/.test(command) &&
        /(reviewThreads|addPullRequestReviewThreadReply|resolveReviewThread)/.test(command));
    if (legacyOperation || directGitHubReviewOperation) {
      return {
        block: true,
        reason: `Direct review-comment fetch/reply operations are blocked during this workflow. Use the fetched artifacts and ${CHECKPOINT_TOOL_NAME}.`,
      };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const lastState = latestCustomEntryData<WorkflowState>(entries, STATE_ENTRY_TYPE);
    githubUsernameCache.reset(lastState?.githubUsername);
    activeWorkflow = lastState?.active ? lastState : undefined;
    if (activeWorkflow && !activeWorkflow.githubUsername) {
      try {
        const client = new GitHubClient(commandExecutor(pi), activeWorkflow.repoRoot);
        const githubUsername = await githubUsernameCache.get(client);
        activeWorkflow = { ...activeWorkflow, githubUsername };
        pi.appendEntry(STATE_ENTRY_TYPE, activeWorkflow);
      } catch (error) {
        ctx.ui.notify(
          `Unable to restore the review workflow's GitHub supervisor: ${
            error instanceof Error ? error.message : String(error)
          }. Run /reload to retry.`,
          "error",
        );
        updateStatus(ctx);
        return;
      }
    }
    terminalThreadIds = new Set(
      entries
        .filter(
          (entry: { type: string; customType?: string }) =>
            entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE,
        )
        .map((entry) => (entry as { data?: { threadId?: string } }).data?.threadId)
        .filter((id): id is string => Boolean(id)),
    );
    if (
      activeWorkflow &&
      activeWorkflow.threadIds.length > 0 &&
      activeWorkflow.threadIds.every((threadId) => terminalThreadIds.has(threadId))
    ) {
      finish(ctx);
    } else {
      setToolEnabled(Boolean(activeWorkflow));
      updateStatus(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(FETCH_WIDGET_ID, undefined);
    ctx.ui.setStatus(STATUS_ID, undefined);
    setToolEnabled(false);
  });
}
