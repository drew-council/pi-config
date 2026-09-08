import { REVIEW_COMMAND_NAME } from "./constants.js";
import type { ReplyRequest } from "./types.js";

export function replyAttribution(githubUsername: string): string {
  return `> \`pi\` agent using \`${REVIEW_COMMAND_NAME}\`, supervised by @${githubUsername}`;
}

const ATTRIBUTION_PATTERN = new RegExp(`\\s*> \`pi\` agent using \`${REVIEW_COMMAND_NAME}\`, supervised by @\\S+\\s*$`);

/** Removes the supervised-agent footer so it does not clutter the agent's context. It still lives in the posted reply. */
export function stripReplyAttribution(body: string): string {
  return body.replace(ATTRIBUTION_PATTERN, "");
}

export function appendReplyAttribution(body: string, githubUsername: string): string {
  const trimmedBody = body.trimEnd();
  const attribution = replyAttribution(githubUsername);
  if (trimmedBody.endsWith(attribution)) return trimmedBody;
  return `${trimmedBody}\n\n${attribution}`;
}

export function createReplyRequest(
  threadId: string,
  draftReply: string,
  resolve: boolean,
  githubUsername: string,
): ReplyRequest {
  return {
    thread_id: threadId,
    comment: appendReplyAttribution(draftReply, githubUsername),
    resolve,
  };
}
