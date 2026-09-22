import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type RepositoryRoot = {
  /** Directory containing `.git` (a main checkout or a linked worktree). */
  root: string;
  /** Root of the main repository; equals `root` unless `root` is a linked worktree or submodule. */
  main: string;
};

/**
 * Walks up from `dir` to the nearest checkout. Linked worktrees
 * (`<main>/.git/worktrees/<name>`) and submodules (`<main>/.git/modules/<path>`)
 * have a `.git` file whose `gitdir:` line resolves back to the main repository.
 * A `.git` file that cannot be parsed ends the walk with no result.
 */
export function findRepositoryRoot(dir: string): RepositoryRoot | undefined {
  let directory = resolve(dir);
  for (;;) {
    const gitPath = join(directory, ".git");
    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory()) return { root: directory, main: directory };
      if (stat.isFile()) {
        const gitdir = /^gitdir:\s*(\S.*\S|\S)\s*$/m.exec(readFileSync(gitPath, "utf8"))?.[1];
        if (!gitdir) return undefined;
        const absolute = isAbsolute(gitdir) ? gitdir : resolve(directory, gitdir);
        const segments = absolute.split(sep);
        const dotGit = segments.lastIndexOf(".git");
        return dotGit > 0 ? { root: directory, main: segments.slice(0, dotGit).join(sep) } : undefined;
      }
    } catch {
      // No .git here; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export const sheerRepositoryPath = (home = homedir()) => resolve(home, "work", "sheer");

/** True when `dir` is inside the Sheer checkout or one of its linked worktrees. */
export function sheerWorkspaceFor(dir: string, home = homedir()): RepositoryRoot | undefined {
  const found = findRepositoryRoot(dir);
  return found && found.main === sheerRepositoryPath(home) ? found : undefined;
}

export const isSheerWorkspace = (dir: string, home = homedir()): boolean => sheerWorkspaceFor(dir, home) !== undefined;
