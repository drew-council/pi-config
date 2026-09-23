/**
 * Keep git from opening an editor in commands Pi runs.
 *
 * Agent bash calls inherit the user's `$EDITOR`, so `git rebase --continue`,
 * `git merge`, `git commit --amend`, and `git rebase -i` launch nvim with no
 * terminal attached and hang until the tool times out. Setting git's own
 * editor variables on Pi's process environment covers the bash tool and `!`
 * commands (both spawn with `{ ...process.env }`), while leaving `$EDITOR`
 * alone for tools that intentionally open it (tuicr, the prompt editor).
 *
 * - `GIT_EDITOR=true` accepts the prepared commit message unchanged.
 * - `GIT_SEQUENCE_EDITOR=true` accepts the generated rebase todo list, so
 *   `git rebase -i --autosquash` runs straight through.
 * - `GIT_MERGE_AUTOEDIT=no` skips the merge-commit message prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NONINTERACTIVE_GIT_ENV = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
} as const;

export default function (_pi: ExtensionAPI) {
  Object.assign(process.env, NONINTERACTIVE_GIT_ENV);
}
