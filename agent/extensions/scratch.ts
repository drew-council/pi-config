/**
 * Give each session one scratch directory and tell the model about it.
 *
 * Directories are grouped under `/tmp/pi/`, keeping the path short in the
 * prompt and in tool calls (macOS's `$TMPDIR` is a long `/var/folders/...`
 * path; its `/tmp` is a symlink to `/private/tmp` and works the same). The name
 * comes from the random tail of the session's UUIDv7 id (its head is a
 * timestamp), so resuming or reloading a session reuses the same directory.
 * Nothing is deleted on shutdown; the OS clears `/tmp` on its own schedule.
 * `PI_SCRATCH_ROOT` replaces `/tmp`, so tests that start Pi can keep it clean.
 */

import { lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = process.env.PI_SCRATCH_ROOT || (process.platform === "win32" ? tmpdir() : "/tmp");

/** Create (or reuse) the session's scratch directory and return its path. */
export function ensureScratchDir(sessionId: string, root = ROOT): string {
  const parent = join(root, "pi");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // `/tmp` is shared, so only use a real `pi` directory we own; otherwise take a fresh random name.
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return mkdtempSync(join(root, "pi-"));
  const dir = join(parent, sessionId.replace(/-/g, "").slice(-8));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function scratchPrompt(dir: string): string {
  return `Your scratch directory for this session is ${dir}. Use it for temporary files, downloads, clones, and throwaway scripts instead of creating other temp directories. It persists across resumes of this session.`;
}

export default function (pi: ExtensionAPI) {
  let dir: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    dir = ensureScratchDir(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", (event) => {
    if (dir) event.systemPromptOptions.sections.scratch = scratchPrompt(dir);
  });
}
