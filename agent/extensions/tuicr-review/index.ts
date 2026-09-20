import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readClipboardText } from "../shared/clipboard.js";
import { latestCustomEntryData } from "../shared/session-entries.js";
import { commentLabel } from "./labels.js";
import { parseTuicrReview, type TuicrComment, type TuicrReview } from "./parser.js";
import { resolveReviewPath } from "./path.js";

const STATE_ENTRY_TYPE = "tuicr-review-state";
const STATUS_ID = "tuicr-review";
const MAX_VISIBLE_COMMENTS = 12;

interface ReviewState {
  review: TuicrReview;
  addressedIds: string[];
  source: string;
}

async function selectComments(
  ctx: ExtensionCommandContext,
  comments: TuicrComment[],
): Promise<TuicrComment[] | undefined> {
  const mode = (ctx as ExtensionCommandContext & { mode?: string }).mode;
  if (!ctx.hasUI || (mode && mode !== "tui")) {
    ctx.ui.notify("tuicr review selection requires interactive TUI mode.", "warning");
    return undefined;
  }

  const selectedIds = await ctx.ui.custom<Set<string> | undefined>((tui, theme, _keybindings, done) => {
    let cursor = 0;
    const selected = new Set<string>();

    const requestRender = () => tui.requestRender();
    const move = (delta: number) => {
      cursor = Math.max(0, Math.min(comments.length - 1, cursor + delta));
      requestRender();
    };

    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.up) || data === "k") {
          move(-1);
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          move(1);
          return;
        }
        if (matchesKey(data, Key.space) || data === " ") {
          const id = comments[cursor]?.id;
          if (id) {
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
          }
          requestRender();
          return;
        }
        if (data === "a") {
          if (selected.size === comments.length) selected.clear();
          else for (const comment of comments) selected.add(comment.id);
          requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(new Set(selected));
          return;
        }
        if (matchesKey(data, Key.escape)) done(undefined);
      },
      render(width: number) {
        const renderWidth = Math.max(1, width);
        const windowStart = Math.max(
          0,
          Math.min(cursor - Math.floor(MAX_VISIBLE_COMMENTS / 2), comments.length - MAX_VISIBLE_COMMENTS),
        );
        const visible = comments.slice(windowStart, windowStart + MAX_VISIBLE_COMMENTS);
        const lines = [
          theme.fg("accent", "─".repeat(renderWidth)),
          truncateToWidth(theme.fg("accent", theme.bold("Select tuicr comments to address")), renderWidth),
          "",
        ];

        for (const [visibleIndex, comment] of visible.entries()) {
          const index = windowStart + visibleIndex;
          const focused = index === cursor;
          const checkbox = selected.has(comment.id) ? "[x]" : "[ ]";
          const prefix = `${focused ? ">" : " "} ${checkbox} `;
          const label = commentLabel(comment);
          const styled = focused ? theme.fg("accent", label) : theme.fg("text", label);
          lines.push(...wrapTextWithAnsi(prefix + styled, renderWidth));
        }

        if (comments.length > MAX_VISIBLE_COMMENTS) {
          lines.push(
            truncateToWidth(
              theme.fg("dim", `  Showing ${windowStart + 1}-${windowStart + visible.length} of ${comments.length}`),
              renderWidth,
            ),
          );
        }
        lines.push(
          "",
          truncateToWidth(
            theme.fg("dim", "↑↓/jk move • Space toggle • a all • Enter continue • Esc cancel"),
            renderWidth,
          ),
        );
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
        return lines;
      },
    };
  });

  if (!selectedIds) return undefined;
  return comments.filter((comment) => selectedIds.has(comment.id));
}

function formatPrompt(comments: TuicrComment[], additionalInformation: string): string {
  const renderedComments = comments.map((comment, index) => {
    const type = comment.type ? `**[${comment.type}]** ` : "";
    const context = comment.context ? ` ${comment.context}` : "";
    const bodyLines = comment.body.split("\n");
    const firstLine = `${index + 1}. ${type}\`${comment.location}\`${context} - ${bodyLines[0] ?? ""}`;
    const indent = " ".repeat(String(index + 1).length + 2);
    return [firstLine, ...bodyLines.slice(1).map((line) => `${indent}${line}`)].join("\n");
  });
  const additional = additionalInformation.trim()
    ? `\n\n## Additional information from the user\n\n${additionalInformation.trim()}`
    : "";

  return `Address the following selected code review comments exactly as described.

Inspect the referenced code and surrounding context, make the necessary changes, and run relevant checks or tests. Address only these selected comments unless another change is strictly required to implement them correctly.

## Selected review comments

${renderedComments.join("\n\n")}${additional}`;
}

export default function tuicrReviewExtension(pi: ExtensionAPI) {
  let state: ReviewState | undefined;

  const persist = () => {
    if (state) pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (!state) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const addressed = new Set(state.addressedIds);
    const remaining = state.review.comments.filter((comment) => !addressed.has(comment.id)).length;
    ctx.ui.setStatus(STATUS_ID, remaining > 0 ? ctx.ui.theme.fg("accent", `tuicr:${remaining}`) : undefined);
  };

  const remainingComments = (): TuicrComment[] => {
    if (!state) return [];
    const addressed = new Set(state.addressedIds);
    return state.review.comments.filter((comment) => !addressed.has(comment.id));
  };

  const clearReview = (ctx: ExtensionContext) => {
    state = undefined;
    pi.appendEntry(STATE_ENTRY_TYPE, undefined);
    updateStatus(ctx);
  };

  const runRound = async (ctx: ExtensionCommandContext) => {
    if (!state) {
      ctx.ui.notify("No active tuicr review.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to finish, then run /tuicr resume.", "warning");
      return;
    }

    const remaining = remainingComments();
    if (remaining.length === 0) {
      updateStatus(ctx);
      ctx.ui.notify("All comments in the active tuicr review have been addressed.", "info");
      return;
    }

    const selected = await selectComments(ctx, remaining);
    if (!selected) return;
    if (selected.length === 0) {
      ctx.ui.notify("No comments selected.", "warning");
      return;
    }

    const additionalInformation = await ctx.ui.editor(
      "Additional information (optional; submit empty to continue)",
      "",
    );
    if (additionalInformation === undefined) return;

    pi.sendUserMessage(formatPrompt(selected, additionalInformation));
    state.addressedIds.push(...selected.map((comment) => comment.id));
    state.addressedIds = [...new Set(state.addressedIds)];
    persist();
    updateStatus(ctx);
  };

  const parseReview = async (argument: string, ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to finish before parsing a review.", "warning");
      return;
    }

    try {
      let markdown: string;
      let source: string;
      if (argument.trim()) {
        source = resolveReviewPath(argument, ctx.cwd);
        markdown = await readFile(source, "utf8");
      } else {
        const clipboard = await readClipboardText((command, args) => pi.exec(command, args));
        markdown = clipboard.text;
        source = clipboard.source;
      }

      const review = parseTuicrReview(markdown);
      if (review.comments.length === 0) {
        throw new Error("No tuicr comments were found in the markdown.");
      }

      state = { review, addressedIds: [], source };
      persist();
      updateStatus(ctx);
      ctx.ui.notify(`Parsed ${review.comments.length} comments from ${source}.`, "info");
      await runRound(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const runDefault = async (ctx: ExtensionCommandContext) => {
    if (remainingComments().length > 0) {
      await runRound(ctx);
      return;
    }

    await parseReview("", ctx);
  };

  pi.registerCommand("tuicr", {
    description: "Parse a tuicr review from the clipboard or resume the active review",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const subcommands = [
        { value: "parse", label: "parse", description: "Parse a review from a file or the system clipboard" },
        { value: "resume", label: "resume", description: "Select more unaddressed comments" },
        { value: "clear", label: "clear", description: "Discard the queued review comments" },
      ];
      const matches = subcommands.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const subcommand = match?.[1]?.toLowerCase();
      const argument = match?.[2] ?? "";

      if (!subcommand) {
        await runDefault(ctx);
        return;
      }
      if (subcommand === "parse") {
        await parseReview(argument, ctx);
        return;
      }
      if (subcommand === "resume" && !argument.trim()) {
        await runRound(ctx);
        return;
      }
      if (subcommand === "clear" && !argument.trim()) {
        const hadReview = state !== undefined;
        clearReview(ctx);
        ctx.ui.notify(hadReview ? "Cleared the queued tuicr review." : "No queued tuicr review to clear.", "info");
        return;
      }

      ctx.ui.notify("Usage: /tuicr [parse [review-file]|resume|clear]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = latestCustomEntryData<ReviewState>(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
