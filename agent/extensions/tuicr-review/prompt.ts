import type { TuicrComment } from "./parser.js";

/** Build the user message that asks the agent to address the selected comments. */
export function formatPrompt(comments: TuicrComment[], additionalInformation: string): string {
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
