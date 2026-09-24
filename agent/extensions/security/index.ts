import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ReviewFn, type ReviewGate, type ReviewVerdict, reviewWithModel } from "./review.js";

type ShellToken = { type: "word" | "control"; value: string };

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let commandSubstitutionDepth = 0;
  let escaped = false;

  const flushWord = () => {
    if (current.length > 0) {
      tokens.push({ type: "word", value: current });
      current = "";
    }
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    // Keep $(...) together so assignments such as TMP_DIR=$(mktemp -d) can
    // be evaluated as a single shell word.
    if (commandSubstitutionDepth > 0) {
      current += char;
      if (char === "(") commandSubstitutionDepth++;
      if (char === ")") commandSubstitutionDepth--;
      continue;
    }

    if (char === "(" && current.endsWith("$")) {
      current += char;
      commandSubstitutionDepth = 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flushWord();
      if (char === "\n") tokens.push({ type: "control", value: char });
      continue;
    }

    if (";&|()<>".includes(char)) {
      flushWord();
      tokens.push({ type: "control", value: char });
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  flushWord();

  return tokens;
}

function isRmCommand(word: string): boolean {
  return word === "rm" || word.endsWith("/rm");
}

function isRecursiveRmFlag(arg: string): boolean {
  return arg === "--recursive" || (/^-[^-]/.test(arg) && /[rR]/.test(arg));
}

type ShellValue = { kind: "safe-path"; value: string } | { kind: "temporary" } | { kind: "unknown" };

function isPathBelowTmp(target: string, cwd: string): boolean {
  if (target.length === 0 || /[`$~]/.test(target)) return false;

  const absoluteTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
  return absoluteTarget !== "/tmp" && absoluteTarget !== "/tmp/" && absoluteTarget.startsWith("/tmp/");
}

function isPiManagedDependencyPath(filePath: string, cwd: string): boolean {
  const managedDependencies = path.join(getAgentDir(), "npm", "node_modules");
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(managedDependencies, absolutePath);
  return relativePath !== "" && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isTemporaryVariableName(name: string): boolean {
  // This is intentionally a little permissive: agents commonly call these
  // TMP_DIR, temp_path, or scratch_dir. The value is still not trusted when
  // it is a literal path outside /tmp.
  return /(?:^|_)(?:tmp|temp|temporary|scratch)(?:dir|path)?(?:_|$)/i.test(name);
}

function variableName(word: string): string | undefined {
  const match = /^(?:\$|\$\{)([A-Za-z_][A-Za-z0-9_]*)(?:})?$/.exec(word);
  return match?.[1];
}

function resolveShellValue(word: string, variables: Map<string, ShellValue>, cwd: string): ShellValue {
  if (isPathBelowTmp(word, cwd)) return { kind: "safe-path", value: word };
  if (/^\$\(\s*mktemp\s+-d(?:\s+[^)]*)?\s*\)$/.test(word)) return { kind: "temporary" };

  const name = variableName(word);
  if (name) return variables.get(name) ?? (isTemporaryVariableName(name) ? { kind: "temporary" } : { kind: "unknown" });

  const prefix = /^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)})(\/.*)$/.exec(word);
  if (prefix) {
    const value = variables.get(prefix[1] ?? prefix[2]);
    if (value?.kind === "temporary") return { kind: "temporary" };
    if (value?.kind === "safe-path" && !prefix[3].includes("..")) {
      return { kind: "safe-path", value: path.join(value.value, prefix[3]) };
    }
  }

  return { kind: "unknown" };
}

function hasSafeRecursiveRmTarget(target: string, variables: Map<string, ShellValue>, cwd: string): boolean {
  const value = resolveShellValue(target, variables, cwd);
  return value.kind === "temporary" || (value.kind === "safe-path" && isPathBelowTmp(value.value, cwd));
}

function hasUnsafeRecursiveRm(command: string, cwd: string): boolean {
  const tokens = tokenizeShell(command);
  const variables = new Map<string, ShellValue>();
  let atCommandStart = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "control") {
      atCommandStart = true;
      continue;
    }

    // Track assignments before a command (including `TMP_DIR=... rm -rf ...`).
    if (atCommandStart) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token.value);
      if (assignment) {
        variables.set(assignment[1], resolveShellValue(assignment[2], variables, cwd));
        continue;
      }
      if (token.value === "export") {
        const next = tokens[i + 1];
        const assignment = next?.type === "word" ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(next.value) : undefined;
        if (assignment) {
          variables.set(assignment[1], resolveShellValue(assignment[2], variables, cwd));
          i++;
          continue;
        }
      }
      atCommandStart = false;
    }

    if (!isRmCommand(token.value)) continue;
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length && tokens[j]?.type === "word"; j++) args.push(tokens[j].value);
    if (!args.some(isRecursiveRmFlag)) continue;

    let afterOptions = false;
    const targets = args.filter((arg) => {
      if (!afterOptions && arg === "--") {
        afterOptions = true;
        return false;
      }
      return afterOptions || !arg.startsWith("-");
    });

    // No target means rm's behavior depends on the shell/environment.
    if (targets.length === 0 || !targets.every((target) => hasSafeRecursiveRmTarget(target, variables, cwd)))
      return true;
  }

  return false;
}

const AI_ATTRIBUTION_PATTERNS = [
  /co-authored-by:\s*[^\n]*\b(?:claude|codex|copilot|cursor|devin|gemini|chatgpt|openai|anthropic|aider|pi)\b/i,
  /(?:generated|created|written|co-authored)\s+(?:with|by)\s+[^\n]*\b(?:claude|codex|copilot|cursor|devin|gemini|chatgpt|openai|anthropic|aider)\b/i,
];

function hasAiAttribution(command: string): boolean {
  if (!/\bgit\b/.test(command)) return false;
  return AI_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(command));
}

const RECURSIVE_DELETE: ReviewGate = {
  name: "recursive delete",
  detection:
    "`rm` with a recursive flag whose targets are not all verifiably under /tmp or a mktemp directory. It can wipe whole directory trees.",
  approveWhen: [
    'It only deletes the OS temp dir, a mktemp directory, or a scratch/worktree/clone directory the agent itself created earlier in this transcript (including "cd /tmp && rm -rf name" and "rm -rf name && mkdir name" patterns).',
    "The user explicitly asked for this deletion, or for a task that plainly requires it (cleaning up files the user asked to remove, recreating node_modules before a reinstall, re-cloning a throwaway checkout).",
    "It removes build output, caches, generated artifacts, or files the agent created in this conversation inside the current project.",
  ],
  askWhen: [
    "The target is a real source tree, home-directory content, dotfiles, credentials, or anything the transcript does not show as scratch or user-requested.",
  ],
};

const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; gate: ReviewGate }> = [
  {
    pattern: /\b(chmod|chown)\b.*777/,
    gate: {
      name: "dangerous permissions",
      detection: "`chmod` or `chown` with mode 777, which makes the target world-writable.",
      approveWhen: ["The only targets are under /tmp or a scratch directory the agent created in this transcript."],
      askWhen: ["Any target is in a project, the home directory, or a system path."],
    },
  },
  {
    pattern: /\bmkfs\b/,
    gate: {
      name: "filesystem format",
      detection: "`mkfs`, which erases and formats a filesystem.",
      approveWhen: [
        "The target is an image file under /tmp that the agent created in this transcript for a task the user asked for.",
      ],
      askWhen: ["The target is a block device or any file the transcript does not show as a scratch image."],
    },
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//,
    gate: {
      name: "raw device write",
      detection: "`dd` writing to a path under /dev/, which can overwrite a disk.",
      approveWhen: ["The output is /dev/null."],
      askWhen: ["The output is any device other than /dev/null."],
    },
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    gate: {
      name: "raw device overwrite",
      detection: "A shell redirect into a /dev/sd* disk device, which overwrites the disk.",
      approveWhen: [],
      askWhen: [],
    },
  },
  {
    pattern: /\bkill\s+-9\s+-1\b/,
    gate: {
      name: "kill all processes",
      detection: "`kill -9 -1`, which kills every process the user owns.",
      approveWhen: [],
      askWhen: [],
    },
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    gate: {
      name: "fork bomb",
      detection: "A shell fork bomb, which exhausts the machine's process table.",
      approveWhen: [],
      askWhen: [],
    },
  },
  {
    pattern: /\bgit\s+clean\s+[^;&|]*-[^;&|]*[df]/,
    gate: {
      name: "destructive git clean",
      detection: "`git clean` with -f or -d, which permanently deletes untracked files and directories.",
      approveWhen: [
        "The user asked to clean the working tree.",
        "The repository is a scratch clone or worktree the agent created in this transcript.",
        "The transcript shows the untracked files are only build output or files the agent created.",
      ],
      askWhen: ["The repository may hold untracked work that the transcript does not discuss."],
    },
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    gate: {
      name: "destructive git reset",
      detection: "`git reset --hard`, which discards uncommitted changes and can drop commits from the branch.",
      approveWhen: [
        "The user asked to reset or discard these changes, or to reset a branch they named.",
        "The repository is a scratch clone or worktree the agent created in this transcript.",
        "The transcript shows a clean working tree and the reset only moves to a commit the user asked for.",
      ],
      askWhen: [
        "The working tree may hold uncommitted work that the transcript does not discuss.",
        "The reset would drop commits the user did not ask to remove.",
      ],
    },
  },
  {
    pattern: /\bgit\s+push\b[^;&|]*\s(?:--force|-f)\b/,
    gate: {
      name: "force push",
      detection: "`git push` with --force, --force-with-lease, or -f, which rewrites history on the remote.",
      approveWhen: [
        "The user asked for this push, or asked to rebase, amend, or restack their own feature branch, and this pushes that branch.",
      ],
      askWhen: [
        "The target is main, master, a release branch, or another shared branch.",
        "The user did not ask to rewrite the branch being pushed.",
      ],
    },
  },
  {
    pattern: /\bgcloud\b/,
    gate: {
      name: "gcloud command",
      detection: "Any `gcloud` invocation. It acts on real Google Cloud projects and resources.",
      approveWhen: [
        "It is read-only (list, describe, logs read, config list, and similar) and does not print secrets, tokens, or keys.",
        "The user explicitly asked for this specific operation on this project and resource.",
      ],
      askWhen: [
        "It creates, updates, deletes, deploys, or changes IAM, config, or auth state, and the user did not explicitly ask for it.",
        "It prints credentials, for example `auth print-access-token` or `secrets versions access`.",
      ],
    },
  },
];

const SUDO_REASON =
  "sudo is never allowed here and no approval prompt will be shown. Do not retry with sudo; if elevated privileges are genuinely required, explain to the user what they should run themselves.";

/** How long the background reviewer may take before the decision is left to the user alone. */
const REVIEW_TIMEOUT_MS = 30_000;

export type SecurityOptions = {
  /** Background reviewer used for confirm-style bash gates. Defaults to the profile's cheap model. */
  review?: ReviewFn;
};

type BlockResult = { block: true; reason: string };

/**
 * Comprehensive security hook:
 * - Hard-blocks sudo, AI co-author attribution, and bash writes to secrets
 * - Confirms dangerous bash commands (rm -rf, git reset --hard, force push, gcloud, ...) with the user,
 *   while a cheap reviewer model checks the transcript in the background and auto-approves
 *   commands that are clearly safe (scratch dirs under /tmp, deletions the user asked for, ...)
 * - Protects sensitive paths from writes (.env, node_modules, .git, keys)
 */
export function createSecurityExtension(pi: ExtensionAPI, options: SecurityOptions = {}) {
  const review: ReviewFn =
    options.review ?? ((ctx, request, signal) => reviewWithModel(ctx, request, signal, getAgentDir()));

  const protectedPaths = [
    { pattern: /(^|\/)\.env($|\.(?!example$))/, desc: "environment file" },
    { pattern: /(^|\/)\.dev\.vars($|\.[^/]+$)/, desc: "dev vars file" },
    { pattern: /(^|\/)node_modules\//, desc: "node_modules" },
    { pattern: /^\.git\/|\/\.git\//, desc: "git directory" },
    { pattern: /\.pem$|\.key$/, desc: "private key file" },
    {
      pattern: /(^|\/)id_rsa$|(^|\/)id_ed25519$|(^|\/)id_ecdsa$/,
      desc: "SSH key",
    },
    { pattern: /(^|\/)\.ssh\//, desc: ".ssh directory" },
    { pattern: /(^|\/)secrets?\.(json|ya?ml|toml)$/i, desc: "secrets file" },
    { pattern: /(^|\/)credentials/i, desc: "credentials file" },
  ];

  const softProtectedPaths = [
    { pattern: /bun\.lockb?$/, desc: "Bun lockfile" },
    { pattern: /package-lock\.json$/, desc: "package-lock.json" },
    { pattern: /yarn\.lock$/, desc: "yarn.lock" },
    { pattern: /pnpm-lock\.yaml$/, desc: "pnpm-lock.yaml" },
  ];

  const protectedShellPath = String.raw`(?:\.\/)?(?:[^\s;&|<>]*\/)?(?:\.env(?:\.(?!example\b)[^\s;&|<>]+)?|\.dev\.vars(?:\.[^\s;&|<>]+)?|[^\s;&|<>]+\.(?:pem|key))`;
  const dangerousBashWrites = [
    new RegExp(String.raw`(?:>|>>|1>|2>|&>|tee\s+(?:-[a-zA-Z]+\s+)*)\s*${protectedShellPath}`),
    new RegExp(String.raw`\b(?:cp|mv)\b[^;&|]*\s${protectedShellPath}(?:\s|$)`),
    new RegExp(String.raw`\bcat\b[^;&|]*(?:>|>>)\s*${protectedShellPath}`),
  ];

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /**
   * Gate a dangerous command. Headless: the reviewer decides. Interactive: the
   * user sees a confirm dialog immediately; if the reviewer approves first, the
   * dialog is dismissed and the command runs.
   */
  async function guardCommand(
    ctx: ExtensionContext,
    gate: ReviewGate,
    command: string,
  ): Promise<BlockResult | undefined> {
    const desc = gate.name;
    const request = { command, cwd: ctx.cwd, gate };

    if (!ctx.hasUI) {
      try {
        const verdict = await review(ctx, request, AbortSignal.timeout(REVIEW_TIMEOUT_MS));
        if (verdict.decision === "approve") return undefined;
        return { block: true, reason: `Blocked ${desc} (no UI to confirm; reviewer: ${verdict.reason})` };
      } catch (error) {
        return {
          block: true,
          reason: `Blocked ${desc} (no UI to confirm; reviewer unavailable: ${errorMessage(error)})`,
        };
      }
    }

    const reviewer = new AbortController();
    const dialog = new AbortController();
    let autoApproved: ReviewVerdict | undefined;
    // Runs concurrently with the dialog; errors surface as a notification only.
    void review(ctx, request, AbortSignal.any([reviewer.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]))
      .then((verdict) => {
        if (reviewer.signal.aborted) return;
        if (verdict.decision === "approve") {
          autoApproved = verdict;
          dialog.abort();
        } else {
          ctx.ui.notify(`Reviewer wants your decision: ${verdict.reason}`, "warning");
        }
      })
      .catch((error) => {
        if (!reviewer.signal.aborted) ctx.ui.notify(`Command reviewer unavailable: ${errorMessage(error)}`, "warning");
      });

    pi.events.emit("herdr:blocked", { active: true, label: "Waiting for command confirmation" });
    try {
      const ok = await ctx.ui.confirm(`Dangerous command: ${desc}`, command, { signal: dialog.signal });
      reviewer.abort();
      if (autoApproved) {
        ctx.ui.notify(`Auto-approved ${desc}: ${autoApproved.reason}`, "info");
        return undefined;
      }
      if (!ok) return { block: true, reason: `Blocked ${desc} by user` };
      return undefined;
    } finally {
      pi.events.emit("herdr:blocked", { active: false });
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = event.input.command as string;

      if (/\bsudo\b/.test(command)) {
        if (ctx.hasUI) ctx.ui.notify("Blocked sudo command (never allowed)", "warning");
        return { block: true, reason: SUDO_REASON };
      }

      if (hasUnsafeRecursiveRm(command, ctx.cwd)) {
        const blocked = await guardCommand(ctx, RECURSIVE_DELETE, command);
        if (blocked) return blocked;
      }

      if (hasAiAttribution(command)) {
        if (ctx.hasUI) ctx.ui.notify("Blocked AI co-author attribution in git command", "warning");
        return {
          block: true,
          reason:
            "Do not attribute commits to yourself (no Co-authored-by or 'Generated with' trailers naming an AI). Commits are the human author's responsibility. Re-run the command without the attribution.",
        };
      }

      for (const { pattern, gate } of DANGEROUS_COMMANDS) {
        if (pattern.test(command)) {
          const blocked = await guardCommand(ctx, gate, command);
          if (blocked) return blocked;
          break;
        }
      }

      for (const pattern of dangerousBashWrites) {
        if (pattern.test(command)) {
          if (ctx.hasUI) ctx.ui.notify("Blocked bash write to protected path", "warning");
          return {
            block: true,
            reason: "Bash command writes to protected path",
          };
        }
      }

      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      const normalizedPath = path.normalize(filePath);

      for (const { pattern, desc } of protectedPaths) {
        // Installed pi packages are intentionally patchable; patch-package uses
        // edits here as the source for persistent patches.
        if (desc === "node_modules" && isPiManagedDependencyPath(filePath, ctx.cwd)) continue;

        if (pattern.test(normalizedPath)) {
          if (ctx.hasUI) ctx.ui.notify(`Blocked write to ${desc}: ${filePath}`, "warning");
          return { block: true, reason: `Protected path: ${desc}` };
        }
      }

      for (const { pattern, desc } of softProtectedPaths) {
        if (pattern.test(normalizedPath)) {
          if (!ctx.hasUI) {
            return { block: true, reason: `Protected path (no UI): ${desc}` };
          }

          const ok = await ctx.ui.confirm(`Modifying ${desc}`, `Are you sure you want to modify ${filePath}?`);

          if (!ok) {
            return { block: true, reason: `User blocked write to ${desc}` };
          }
          break;
        }
      }

      return undefined;
    }

    return undefined;
  });
}

export default function (pi: ExtensionAPI) {
  createSecurityExtension(pi);
}
