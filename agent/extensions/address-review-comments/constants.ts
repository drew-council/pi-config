export const REVIEW_COMMAND_NAME = "address-review-comments";
export const REVIEW_COMMAND = `/${REVIEW_COMMAND_NAME}`;
export const AUTHOR_COMMENTS_FLAG = "--author-comments";
export const REVIEW_COMMAND_USAGE = `${REVIEW_COMMAND} [PR_NUMBER] [${AUTHOR_COMMENTS_FLAG}]`;
export const REVIEW_COMMAND_ALIAS_NAME = "gh-review-comments";
export const REVIEW_COMMAND_ALIAS = `/${REVIEW_COMMAND_ALIAS_NAME}`;

export const CHECKPOINT_TOOL_NAME = "github_review_checkpoint";
export const STATE_ENTRY_TYPE = "github-review-comments-state";
export const CHECKPOINT_ENTRY_TYPE = "github-review-comments-checkpoint";
export const STATUS_ID = "github-review-comments";
export const FETCH_WIDGET_ID = "github-review-comments-fetch";

export const LEGACY_SKILL_PATH = ".agents/skills/address-review-comments/SKILL.md";
