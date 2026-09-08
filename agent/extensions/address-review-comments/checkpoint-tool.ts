import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeReplyRequest } from "./artifacts.js";
import { appendReplyAttribution, createReplyRequest, stripReplyAttribution } from "./attribution.js";
import { checkpointAction, ReviewCheckpointDialog } from "./checkpoint-dialog.js";
import { CHECKPOINT_ENTRY_TYPE, CHECKPOINT_TOOL_NAME, REVIEW_COMMAND } from "./constants.js";
import { queueCheckpointFeedback } from "./feedback-message.js";
import { GitHubClient, ReviewThreadResolveError } from "./github.js";
import type { CheckpointOption, CheckpointParams, RecommendedAction, ReplyResponse, WorkflowState } from "./types.js";

const RECOMMENDED_ACTIONS = ["resolve", "post"] as const;

interface CheckpointController {
  getWorkflow(): WorkflowState | undefined;
  isTerminal(threadId: string): boolean;
  finish(ctx: ExtensionContext): void;
  markTerminal(threadId: string, ctx: ExtensionContext): boolean;
}

function isRecommendedAction(value: unknown): value is RecommendedAction {
  return typeof value === "string" && RECOMMENDED_ACTIONS.includes(value as RecommendedAction);
}

export function registerCheckpointTool(pi: ExtensionAPI, controller: CheckpointController): void {
  pi.registerTool({
    name: CHECKPOINT_TOOL_NAME,
    label: "Review Checkpoint",
    description:
      "Present one PR review-thread checkpoint for mandatory human approval. On approval, this tool posts the reply and optionally resolves the thread through gh.",
    promptSnippet: "Present a PR review-comment checkpoint before posting or resolving a review thread",
    promptGuidelines: [
      `Use ${CHECKPOINT_TOOL_NAME} for every PR review-comment reply decision; do not submit review replies another way.`,
      `After ${CHECKPOINT_TOOL_NAME} returns edit or feedback, update the draft or code and call it again for the same thread.`,
      `After ${CHECKPOINT_TOOL_NAME} returns skip, revert changes for that thread and continue.`,
    ],
    parameters: Type.Object(
      {
        threadId: Type.String({ description: "GitHub review thread id from the fetched payload" }),
        location: Type.String({ description: "Human-readable file:line location" }),
        reviewer: Type.Optional(Type.String({ description: "Reviewer login, if known" })),
        checkpointMarkdown: Type.String({
          description: "Markdown summary containing the comment, analysis, changes, and relevant diff",
        }),
        draftReply: Type.String({ description: "Exact proposed GitHub reply body" }),
        recommendedAction: Type.Optional(
          StringEnum(RECOMMENDED_ACTIONS, { description: "Recommended approval action for display only" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        throw new Error(`${CHECKPOINT_TOOL_NAME} requires the interactive TUI because human approval is mandatory.`);
      }
      const workflow = controller.getWorkflow();
      if (!workflow) {
        throw new Error(`No active review-comment workflow. Start one with ${REVIEW_COMMAND} first.`);
      }

      const checkpoint = params as CheckpointParams;
      if (!workflow.threadIds.includes(checkpoint.threadId)) {
        throw new Error(
          `Review thread ${checkpoint.threadId} is not part of the active PR #${workflow.prNumber} workflow.`,
        );
      }
      if (controller.isTerminal(checkpoint.threadId)) {
        throw new Error(`Review thread ${checkpoint.threadId} already has a terminal decision.`);
      }
      onUpdate?.({
        content: [{ type: "text", text: `Waiting for approval: ${checkpoint.location}` }],
        details: { phase: "approval", threadId: checkpoint.threadId },
      });
      const selectedOption = await ctx.ui.custom<CheckpointOption | undefined>(
        (tui, theme, _keybindings, done) => new ReviewCheckpointDialog(tui, theme, checkpoint, done),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
        },
      );

      if (!selectedOption) {
        controller.finish(ctx);
        return {
          content: [
            {
              type: "text",
              text: "User dismissed the checkpoint. Treat this as abort and summarize the current state.",
            },
          ],
          details: { selectedOption: "abort", threadId: checkpoint.threadId },
        };
      }

      const action = checkpointAction(selectedOption);
      if (action.kind === "revise") {
        const userText = queueCheckpointFeedback(pi, (await ctx.ui.editor(action.prompt, "")) ?? "");
        return {
          content: [
            {
              type: "text",
              text: userText
                ? `User feedback follows in the next message. Incorporate it, then call ${CHECKPOINT_TOOL_NAME} again for this thread.`
                : `No feedback provided. Call ${CHECKPOINT_TOOL_NAME} again for this thread.`,
            },
          ],
          details: { selectedOption, threadId: checkpoint.threadId, userText },
        };
      }

      if (action.kind === "abort") {
        controller.finish(ctx);
        return {
          content: [{ type: "text", text: "User selected abort. Stop processing and summarize the current state." }],
          details: { selectedOption, threadId: checkpoint.threadId },
        };
      }

      if (action.kind === "skip") {
        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
          threadId: checkpoint.threadId,
          selectedOption,
          location: checkpoint.location,
        });
        const complete = controller.markTerminal(checkpoint.threadId, ctx);
        return {
          content: [
            {
              type: "text",
              text: complete
                ? "User selected skip. Post nothing, revert this thread's changes, then summarize the completed workflow."
                : "User selected skip. Post nothing, revert this thread's changes, and continue to the next thread.",
            },
          ],
          details: { selectedOption, threadId: checkpoint.threadId },
        };
      }

      if (!workflow.githubUsername) {
        throw new Error("The review workflow is missing its authenticated GitHub username. Run /reload to retry.");
      }
      const replyRequest = createReplyRequest(
        checkpoint.threadId,
        checkpoint.draftReply,
        action.resolveThread,
        workflow.githubUsername,
      );
      onUpdate?.({
        content: [
          {
            type: "text",
            text: action.resolveThread ? "Posting reply, then resolving thread…" : "Posting review reply…",
          },
        ],
        details: { phase: "submitting", selectedOption, threadId: checkpoint.threadId },
      });
      await writeReplyRequest(workflow.artifactDirectory || path.dirname(workflow.fetchResponsePath), replyRequest);
      const client = new GitHubClient((command, args, options) => pi.exec(command, args, options), workflow.repoRoot);
      let response: ReplyResponse;
      try {
        response = await client.submitReply(
          checkpoint.threadId,
          replyRequest.comment,
          action.resolveThread,
          signal,
          (reply) => {
            if (!action.resolveThread) return;
            onUpdate?.({
              content: [{ type: "text", text: "Reply posted; resolving review thread…" }],
              details: {
                phase: "resolving",
                selectedOption,
                threadId: checkpoint.threadId,
                replyUrl: reply.url,
              },
            });
          },
        );
      } catch (error) {
        if (!(error instanceof ReviewThreadResolveError)) throw error;
        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
          threadId: checkpoint.threadId,
          selectedOption: "resolve-failed",
          location: checkpoint.location,
          reply: error.reply,
          resolveError: error.message,
        });
        const complete = controller.markTerminal(checkpoint.threadId, ctx);
        return {
          content: [
            {
              type: "text",
              text: `${error.message}\n\nGitHub reply response:\n\n\`\`\`json\n${JSON.stringify(
                {
                  thread_id: checkpoint.threadId,
                  reply: { ...error.reply, body: stripReplyAttribution(error.reply.body) },
                },
                null,
                2,
              )}\n\`\`\`\n\nDo not post the reply again. Flag the thread as replied-but-unresolved and ${
                complete ? "summarize the completed workflow." : "continue to the next review thread."
              }`,
            },
          ],
          details: {
            selectedOption: "resolve-failed",
            threadId: checkpoint.threadId,
            reply: error.reply,
            resolveError: error.message,
          },
        };
      }
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
        threadId: checkpoint.threadId,
        selectedOption,
        location: checkpoint.location,
        response,
      });
      const complete = controller.markTerminal(checkpoint.threadId, ctx);

      return {
        content: [
          {
            type: "text",
            text: `User selected ${selectedOption}. GitHub response:\n\n\`\`\`json\n${JSON.stringify(
              { ...response, reply: { ...response.reply, body: stripReplyAttribution(response.reply.body) } },
              null,
              2,
            )}\n\`\`\`\n\n${
              complete
                ? "The workflow is complete. Summarize addressed, skipped, and flagged threads."
                : "Continue to the next review thread."
            }`,
          },
        ],
        details: { selectedOption, threadId: checkpoint.threadId, response },
      };
    },
    renderCall(args) {
      const location = typeof args.location === "string" ? args.location : "unknown location";
      const reviewer = typeof args.reviewer === "string" ? `@${args.reviewer}` : undefined;
      const summary =
        typeof args.checkpointMarkdown === "string" ? args.checkpointMarkdown : "No checkpoint summary provided.";
      const draftReply = typeof args.draftReply === "string" ? args.draftReply : "";
      const githubUsername = controller.getWorkflow()?.githubUsername;
      const reply = githubUsername ? appendReplyAttribution(draftReply, githubUsername) : draftReply;
      const recommended = isRecommendedAction(args.recommendedAction) ? args.recommendedAction : undefined;
      const metadata = [
        `**Location:** \`${location}\``,
        reviewer ? `**Reviewer:** ${reviewer}` : undefined,
        recommended ? `**Recommended action:** \`${recommended}\`` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      return new Markdown(
        `## Review checkpoint\n\n${metadata}\n\n---\n\n${summary}\n\n---\n\n### Draft reply\n\n${reply}`,
        0,
        0,
        getMarkdownTheme(),
      );
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as
        | { phase?: string; selectedOption?: string; response?: { reply?: { url?: string } }; userText?: string }
        | undefined;
      if (isPartial) {
        const text = result.content[0];
        return new Text(theme.fg("warning", text?.type === "text" ? text.text : "Working…"), 0, 0);
      }
      if (!details?.selectedOption) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      let text = `${theme.fg("success", "✓")} ${theme.fg("accent", details.selectedOption)}`;
      if (details.response?.reply?.url) text += `\n${theme.fg("dim", details.response.reply.url)}`;
      if (details.userText) text += `\n${theme.fg("dim", "user input provided")}`;
      return new Text(text, 0, 0);
    },
  });
}
