/**
 * Warn the agent about raw `go` commands inside the Sheer checkout and its
 * linked worktrees. The command still runs; the warning is appended to its result.
 *
 * Sheer configures test flags, environment, data dependencies, and skips in
 * BUILD.bazel, so plain `go test`/`go build` produce false failures and miss
 * Bazel's caches. `//go:generate` directives need the compiled `graph` binary,
 * which only `make generate` provides. Each warning tells the agent the
 * Bazel or Make command to prefer, with package paths translated to
 * labels relative to the repository root.
 */

import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { sheerWorkspaceFor } from "./shared/sheer-workspace.js";

const WARNED_SUBCOMMANDS = new Set(["test", "build", "vet", "generate", "run"]);
const GO_TEST_VALUE_FLAGS = new Set([
  "bench",
  "benchtime",
  "blockprofile",
  "count",
  "coverpkg",
  "covermode",
  "coverprofile",
  "cpu",
  "cpuprofile",
  "exec",
  "fuzz",
  "fuzztime",
  "gcflags",
  "ldflags",
  "list",
  "memprofile",
  "mod",
  "o",
  "outputdir",
  "p",
  "parallel",
  "run",
  "skip",
  "tags",
  "timeout",
  "trace",
]);

type Segment = { words: string[]; cwd: string };

/**
 * Split a command into simple commands, tracking the working directory each
 * one runs in. `cd`/`pushd` update the directory for following segments;
 * subshells restore it on `)`. Quotes and `$(...)` keep their contents in one
 * word. Directories that cannot be resolved statically leave the cwd unchanged,
 * which keeps the guard active rather than silently disabling it.
 */
function splitSegments(command: string, baseCwd: string, home: string): Segment[] {
  const segments: Segment[] = [];
  const stack: string[] = [];
  let cwd = baseCwd;
  let words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let substitution = 0;
  let escaped = false;
  let hasWord = false;

  const flushWord = () => {
    if (hasWord) words.push(current);
    current = "";
    hasWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length > 0) {
      segments.push({ words, cwd });
      cwd = applyDirectoryChange(words, cwd, home);
    }
    words = [];
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (substitution > 0) {
      current += char;
      if (char === "(") substitution++;
      if (char === ")") substitution--;
      continue;
    }
    if (char === "(" && current.endsWith("$")) {
      current += char;
      substitution = 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (char === "\n") flushSegment();
      else flushWord();
      continue;
    }
    if (char === "(") {
      flushSegment();
      stack.push(cwd);
      continue;
    }
    if (char === ")") {
      flushSegment();
      cwd = stack.pop() ?? cwd;
      continue;
    }
    if (";&|".includes(char)) {
      flushSegment();
      continue;
    }
    current += char;
    hasWord = true;
  }
  if (escaped) {
    current += "\\";
    hasWord = true;
  }
  flushSegment();
  return segments;
}

function applyDirectoryChange(words: string[], cwd: string, home: string): string {
  const [command, ...args] = words;
  if (command !== "cd" && command !== "pushd") return cwd;
  const target = args.find((arg) => !arg.startsWith("-"));
  if (target === undefined) return home;
  if (/[$`]/.test(target) || target === "-") return cwd;
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  return resolve(cwd, target);
}

/** Strip env assignments and common wrappers (`env`, `time`, `timeout 30`) to find the command word. */
function stripPrefixes(words: string[]): string[] {
  let index = 0;
  for (;;) {
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
    const word = words[index];
    if (word === "env" || word === "time" || word === "nice") {
      index++;
      while (index < words.length && words[index].startsWith("-")) index++;
      continue;
    }
    if (word === "timeout") {
      index++;
      while (index < words.length && words[index].startsWith("-")) {
        // -k/-s take a separate value unless written as -k=5 or --kill-after=5.
        const flag = words[index++];
        if (/^(?:-k|-s|--kill-after|--signal)$/.test(flag)) index++;
      }
      index++; // duration
      continue;
    }
    return words.slice(index);
  }
}

function isGoExecutable(word: string | undefined): boolean {
  return word === "go" || word?.endsWith("/go");
}

type GoInvocation = { subcommand: string; args: string[] };

function parseGoInvocation(words: string[]): GoInvocation | undefined {
  const [executable, subcommand, ...args] = stripPrefixes(words);
  if (!isGoExecutable(executable) || !subcommand || !WARNED_SUBCOMMANDS.has(subcommand)) return undefined;
  return { subcommand, args };
}

function looksLikePackagePath(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg.endsWith("...") ||
    arg.endsWith(".go")
  );
}

type Translation = { labels: string[]; goPatterns: string[]; flags: string[] };

/** Separate flags from package arguments and rewrite both for Bazel, relative to the repository root. */
function translateArgs(invocation: GoInvocation, cwd: string, root: string): Translation {
  const labels: string[] = [];
  const goPatterns: string[] = [];
  const flags: string[] = [];
  const args = invocation.args;
  let sawPackage = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      const match = /^--?([^=]+)(?:=(.*))?$/.exec(arg);
      const name = match?.[1] ?? "";
      let value = match?.[2];
      if (value === undefined && GO_TEST_VALUE_FLAGS.has(name) && name !== "v") value = args[++i];
      if (invocation.subcommand !== "test") continue;
      if (name === "run" && value) flags.push(`--test_filter=${value}`);
      else if (name === "count" && value === "1") flags.push("--nocache_test_results");
      else if (name === "v") flags.push("--test_output=all");
      continue;
    }
    if (!looksLikePackagePath(arg)) continue;
    sawPackage = true;
    const recursive = arg === "..." || arg.endsWith("/...");
    const trimmed = recursive ? arg.slice(0, -3).replace(/\/$/, "") || "." : arg;
    const directory = trimmed.endsWith(".go") ? dirname(trimmed) : trimmed;
    const rel = relative(root, resolve(cwd, directory));
    if (rel.startsWith("..") || rel.startsWith("/")) continue;
    if (recursive) {
      labels.push(rel ? `//${rel}/...` : "//...");
      goPatterns.push(rel ? `./${rel}/...` : "./...");
    } else {
      labels.push(rel ? `//${rel}:all` : "//:all");
      goPatterns.push(rel ? `./${rel}` : ".");
    }
  }
  if (labels.length === 0 && !sawPackage) {
    // Go defaults to the package in the current directory.
    const rel = relative(root, cwd);
    if (!rel.startsWith("..") && !rel.startsWith("/")) {
      labels.push(rel ? `//${rel}:all` : "//:all");
      goPatterns.push(rel ? `./${rel}` : ".");
    }
  }
  return { labels: unique(labels), goPatterns: unique(goPatterns), flags: unique(flags) };
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

function guidance(invocation: GoInvocation, translation: Translation): string {
  const targets = translation.labels.join(" ") || "//path/to/package/...";
  const patterns = translation.goPatterns.join(" ");
  const [reason, replacement] = ((): [string, string] => {
    switch (invocation.subcommand) {
      case "test": {
        const flags = translation.flags.length > 0 ? ` ${translation.flags.join(" ")}` : "";
        return ["test flags, env, data deps, and skips live in BUILD.bazel", `bazel test ${targets}${flags}`];
      }
      case "build":
        return ["it skips the nogo analyzers", `bazel build ${targets}`];
      case "vet":
        return [
          "it does not run nogo, the project's analyzers",
          `bazel build ${targets} (or scripts/golangci-lint.sh run)`,
        ];
      case "run":
        return ["binaries are built through Bazel", `bazel run ${translation.labels[0] ?? "//cmd/<binary>"}`];
      case "generate": {
        const scope = patterns === "./..." || patterns === "" ? "" : ` PKG=${patterns}`;
        return ["directives need the freshly built `graph` binary", `make generate${scope} (from the repo root)`];
      }
      default:
        return ["this repo builds through Bazel", `bazel build ${targets}`];
    }
  })();
  return [
    `NOT VALID: raw \`go ${invocation.subcommand}\` output does not count in this Bazel repo, even when it succeeds (${reason}).`,
    `Run instead: ${replacement}`,
    "Do not report results from the command above, and use the Bazel/Make form for every later Go check here.",
  ].join("\n");
}

/** Returns the warning for the first raw Go command that should go through Bazel, or undefined when there is none. */
export function bazelWarning(command: string, cwd: string, home = homedir()): string | undefined {
  for (const segment of splitSegments(command, cwd, home)) {
    const invocation = parseGoInvocation(segment.words);
    if (!invocation) continue;
    const workspace = sheerWorkspaceFor(segment.cwd, home);
    if (!workspace) continue;
    return guidance(invocation, translateArgs(invocation, segment.cwd, workspace.root));
  }
  return undefined;
}

/** Appends the Bazel warning to a raw go command's bash result in a Sheer workspace. */
function warnOnToolResult(
  event: ToolResultEvent,
  ctx: ExtensionContext,
  home = homedir(),
): ToolResultEventResult | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command;
  if (typeof command !== "string") return undefined;
  const warning = bazelWarning(command, ctx.cwd, home);
  if (!warning) return undefined;
  if (ctx.hasUI) ctx.ui.notify("Raw go command in Sheer workspace; Bazel warning sent to the agent", "warning");
  return { content: [...event.content, { type: "text", text: `\n\n⚠️ ${warning}` }] };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event, ctx) => warnOnToolResult(event, ctx));
}

export const _test = { splitSegments, parseGoInvocation, translateArgs, warnOnToolResult };
