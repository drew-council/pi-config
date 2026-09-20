/** Where a review to queue comes from. */
export type ReviewInput = { type: "clipboard" } | { type: "file"; argument: string };

export type TuicrCommandPlan =
  | { kind: "parse"; input: ReviewInput }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "usage" };

export const TUICR_USAGE = "Usage: /tuicr [parse [review-file]|resume|clear]";

/**
 * Decide what a `/tuicr` invocation should do.
 *
 * With no subcommand this is the primary flow: resume the queue when comments
 * remain, otherwise try to parse a review from the clipboard. The explicit
 * subcommands stay available for files, forced resumes, and clearing.
 */
export function planTuicrCommand(args: string, remaining: number): TuicrCommandPlan {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const subcommand = match?.[1]?.toLowerCase();
  const argument = match?.[2] ?? "";

  if (!subcommand) {
    return remaining > 0 ? { kind: "resume" } : { kind: "parse", input: { type: "clipboard" } };
  }
  if (subcommand === "parse") {
    return { kind: "parse", input: argument.trim() ? { type: "file", argument } : { type: "clipboard" } };
  }
  if (subcommand === "resume" && !argument.trim()) {
    return { kind: "resume" };
  }
  if (subcommand === "clear" && !argument.trim()) {
    return { kind: "clear" };
  }
  return { kind: "usage" };
}
