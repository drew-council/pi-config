import { AUTHOR_COMMENTS_FLAG, REVIEW_COMMAND_USAGE } from "./constants.js";

export interface AddressReviewArgs {
  prNumber?: number;
  /** Include review threads started by the PR author, which are skipped by default. */
  includeAuthorComments: boolean;
}

export function parseAddressReviewArgs(
  args: string,
): ({ ok: true } & AddressReviewArgs) | { ok: false; message: string } {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  const includeAuthorComments = parts.includes(AUTHOR_COMMENTS_FLAG);
  const rest = parts.filter((part) => part !== AUTHOR_COMMENTS_FLAG);
  if (rest.some((part) => part.startsWith("-"))) {
    return { ok: false, message: `Unsupported option. Use ${REVIEW_COMMAND_USAGE}.` };
  }
  if (rest.length > 1) {
    return { ok: false, message: `Too many arguments. Use ${REVIEW_COMMAND_USAGE}.` };
  }
  if (rest[0] && !/^\d+$/.test(rest[0])) {
    return { ok: false, message: "PR number must be a positive integer." };
  }
  return { ok: true, prNumber: rest[0] ? Number(rest[0]) : undefined, includeAuthorComments };
}
