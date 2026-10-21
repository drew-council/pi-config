#!/usr/bin/env bun
/**
 * Generate every agent's skill directory from ./skills, the single source of truth.
 *
 * Each ./skills/<name>/ holds a SKILL.md and any supporting files. Its frontmatter is a superset
 * of the Agent Skills, Pi, Codex, and Claude Code fields; each consumer receives only the fields
 * it understands. Two extra keys are consumed here and never emitted:
 *
 *   targets: [pi, codex, claude]   # default: all
 *   source:                        # optional; exactly one of `command` or `git`
 *     command: herdr --skill       # stdout is a SKILL.md
 *     git: https://github.com/github/gh-stack
 *     path: skills/gh-stack        # directory containing SKILL.md, or a lone skill file (default: repository root)
 *     ref: main                    # branch, tag, or commit (default: remote HEAD)
 *     into: references             # copy `path` into this subdirectory instead of expecting an upstream SKILL.md
 *
 * With a source, the upstream skill directory is materialized (for `command`, stdout becomes its
 * SKILL.md) and the skill's `upstream.patch`, if present, is applied to it with `git apply`. Local
 * frontmatter then overrides upstream frontmatter key by key, a non-empty local body is appended to
 * the upstream body, and local files overlay upstream files. Regenerate a patch by diffing an
 * edited copy against the upstream directory, e.g. `git diff --no-index a/ b/ > upstream.patch`.
 * `{{skillDir}}` in local files expands to the home-relative skill directory of each consumer.
 * `disable-model-invocation: true` becomes `policy.allow_implicit_invocation: false` in Codex's
 * agents/openai.yaml, which only Codex receives.
 *
 * Generated directories contain a marker file; directories without one are never touched. Marked
 * directories whose skill no longer exists, or whose source is unavailable on this machine, are
 * removed; a skill that fails for any other reason (bad frontmatter, a patch that no longer
 * applies) keeps its previous output and makes the script exit non-zero.
 */
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export type Target = "pi" | "codex" | "claude";
export const TARGETS: Target[] = ["pi", "codex", "claude"];

/** Each consumer's config directory, relative to home; skills are generated into its `skills/`. */
const TARGET_CONFIG_DIRS: Record<Target, string> = {
  pi: ".pi/agent",
  codex: ".codex",
  claude: ".claude",
};

const SPEC_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
const TARGET_FIELDS: Record<Target, Set<string>> = {
  pi: new Set([...SPEC_FIELDS, "disable-model-invocation"]),
  // Codex rejects any other key (see its bundled skill-creator's quick_validate.py).
  codex: new Set(["name", "description", "license", "allowed-tools", "metadata"]),
  claude: new Set([
    ...SPEC_FIELDS,
    "disable-model-invocation",
    "user-invocable",
    "argument-hint",
    "when_to_use",
    "model",
    "effort",
    "context",
    "agent",
    "hooks",
    "paths",
  ]),
};
const KNOWN_FIELDS = new Set(Object.values(TARGET_FIELDS).flatMap((fields) => [...fields]));

export const MARKER_FILE = ".managed-by-pi-skills";
const CODEX_AGENT_FILE = "agents/openai.yaml";
const PATCH_FILE = "upstream.patch";
const SKILL_DIR_TOKEN = "{{skillDir}}";

type Frontmatter = Record<string, unknown>;
type Source = { command: string } | { git: string; path?: string; ref?: string; into?: string };

interface SkillFile {
  frontmatter: Frontmatter;
  body: string;
}

interface FileEntry {
  from: string;
  /** Local files get `{{skillDir}}` expanded; upstream files are copied verbatim. */
  local: boolean;
}

export interface ResolvedSkill {
  name: string;
  targets: Target[];
  frontmatter: Frontmatter;
  body: string;
  files: Map<string, FileEntry>;
  /** Short description of where the skill came from, for logging. */
  origin: string;
}

/** A source that could not be fetched on this machine: warn and drop the skill, do not fail. */
class SourceError extends Error {}

export interface SyncOptions {
  sourceDir: string;
  home: string;
  cacheDir: string;
  log?: (message: string) => void;
}

export interface SyncResult {
  written: string[];
  removed: string[];
  warnings: string[];
  errors: string[];
}

export function parseSkillFile(text: string, label: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: {}, body: text.replace(/^\s*\n/, "") };

  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(match[1]) ?? {};
  } catch (error) {
    throw new Error(`${label}: invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`${label}: frontmatter must be a YAML mapping`);
  }
  return { frontmatter: frontmatter as Frontmatter, body: text.slice(match[0].length).replace(/^\s*\n/, "") };
}

function stringifyYaml(value: unknown): string {
  return Bun.YAML.stringify(value, null, 2).replace(/[ \t]+$/gm, "");
}

export function renderSkillFile(frontmatter: Frontmatter, body: string): string {
  return `---\n${stringifyYaml(frontmatter)}\n---\n\n${body.trimEnd()}\n`;
}

/** The frontmatter one consumer receives, in source order. */
export function targetFrontmatter(frontmatter: Frontmatter, target: Target): Frontmatter {
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => TARGET_FIELDS[target].has(key)));
}

export function skillDirFor(target: Target, name: string): string {
  return `~/${TARGET_CONFIG_DIRS[target]}/skills/${name}`;
}

function parseTargets(value: unknown, label: string): Target[] {
  if (value === undefined) return TARGETS;
  if (!Array.isArray(value) || value.some((target) => !TARGETS.includes(target))) {
    throw new Error(`${label}: targets must be a list of ${TARGETS.join(", ")}`);
  }
  return value as Target[];
}

function parseSource(value: unknown, label: string): Source | undefined {
  if (value === undefined) return undefined;
  const source = value as Record<string, unknown>;
  const isString = (key: string) => source[key] === undefined || typeof source[key] === "string";
  if (
    typeof value !== "object" ||
    value === null ||
    ["command", "git", "path", "ref", "into"].some((k) => !isString(k))
  ) {
    throw new Error(`${label}: source must be a mapping of strings`);
  }
  const keys = Object.keys(source);
  if (typeof source.command === "string" && keys.length === 1) return { command: source.command };
  if (typeof source.git === "string" && keys.every((key) => ["git", "path", "ref", "into"].includes(key))) {
    return {
      git: source.git,
      path: source.path as string | undefined,
      ref: source.ref as string | undefined,
      into: source.into as string | undefined,
    };
  }
  throw new Error(`${label}: source must be either { command } or { git, path?, ref?, into? }`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function run(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = stderr.trim().split("\n").slice(-3).join(" ");
    throw new SourceError(`\`${argv.join(" ")}\` exited with ${code}${detail ? `: ${detail}` : ""}`);
  }
  return stdout;
}

/** Recursively list files under `dir` as relative path -> entry, skipping VCS and sync metadata. */
async function listFiles(dir: string, local: boolean): Promise<Map<string, FileEntry>> {
  const files = new Map<string, FileEntry>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(entry.parentPath, entry.name);
    const rel = from.slice(dir.length + 1);
    if (rel === "SKILL.md" || rel === MARKER_FILE || rel.split("/").includes(".git")) continue;
    if (local && rel === PATCH_FILE) continue;
    files.set(rel, { from, local });
  }
  return files;
}

class GitCache {
  private checkouts = new Map<string, Promise<string>>();

  constructor(
    private cacheDir: string,
    private warn: (message: string) => void,
  ) {}

  /** Fetch `url` at `ref` into a shared shallow checkout; reuse the last checkout when offline. */
  checkout(url: string, ref: string | undefined): Promise<string> {
    const key = `${url}#${ref ?? ""}`;
    let checkout = this.checkouts.get(key);
    if (!checkout) {
      checkout = this.update(url, ref);
      this.checkouts.set(key, checkout);
    }
    return checkout;
  }

  private async update(url: string, ref: string | undefined): Promise<string> {
    const slug = (value: string) => value.replace(/^[a-z]+:\/\//, "").replace(/[^\w.-]+/g, "_");
    const dir = join(this.cacheDir, "git", slug(url) + (ref ? `@${slug(ref)}` : ""));
    if (!(await exists(join(dir, ".git")))) {
      await mkdir(dir, { recursive: true });
      await run(["git", "init", "-q"], dir);
      await run(["git", "remote", "add", "origin", url], dir);
    } else {
      await run(["git", "remote", "set-url", "origin", url], dir);
    }

    try {
      await run(["git", "fetch", "-q", "--depth", "1", "origin", ref ?? "HEAD"], dir);
      await run(["git", "checkout", "-q", "--force", "--detach", "FETCH_HEAD"], dir);
      await run(["git", "clean", "-qfdx"], dir);
    } catch (error) {
      const cached = await run(["git", "rev-parse", "-q", "--verify", "HEAD"], dir).catch(() => undefined);
      if (!cached) throw error;
      this.warn(`${url}: fetch failed, using cached checkout ${cached.trim().slice(0, 12)} (${error.message})`);
    }
    return dir;
  }
}

/** Copy or generate the upstream skill into `workDir/<name>` and apply the local patch, if any. */
async function materializeUpstream(dir: string, source: Source, workDir: string, git: GitCache): Promise<string> {
  const upstreamDir = join(workDir, basename(dir));
  if ("command" in source) {
    const stdout = await run(["sh", "-c", source.command], dir);
    if (!stdout.trim()) throw new SourceError(`\`${source.command}\` printed nothing`);
    await mkdir(upstreamDir, { recursive: true });
    await writeFile(join(upstreamDir, "SKILL.md"), stdout);
  } else {
    const checkout = await git.checkout(source.git, source.ref);
    const from = resolve(checkout, source.path ?? ".");
    const fromStat = await stat(from).catch(() => undefined);
    if (source.into !== undefined) {
      const dest = resolve(upstreamDir, source.into);
      if (!source.into.trim() || dest === upstreamDir || !dest.startsWith(`${upstreamDir}${sep}`)) {
        throw new Error(`skills/${basename(dir)}/SKILL.md: source.into must be a relative subdirectory`);
      }
      if (fromStat?.isFile()) {
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(from, dest);
      } else if (fromStat?.isDirectory()) {
        await cp(from, dest, { recursive: true, filter: (path) => basename(path) !== ".git" });
      } else {
        throw new SourceError(`${source.git}: no ${source.path ?? "repository root"}`);
      }
    } else if (fromStat?.isFile()) {
      // A lone file, e.g. a SKILL.md at the root of a repository whose other files are not the skill's.
      await mkdir(upstreamDir, { recursive: true });
      await copyFile(from, join(upstreamDir, "SKILL.md"));
    } else if (await exists(join(from, "SKILL.md"))) {
      await cp(from, upstreamDir, { recursive: true, filter: (path) => basename(path) !== ".git" });
    } else {
      throw new SourceError(`${source.git}: no SKILL.md at ${source.path ?? "repository root"}`);
    }
  }

  const patch = join(dir, PATCH_FILE);
  if (await exists(patch)) {
    // The ceiling keeps `git apply` from treating an enclosing repository as the patch root.
    await run(["git", "apply", "--whitespace=nowarn", patch], upstreamDir, {
      GIT_CEILING_DIRECTORIES: dirname(upstreamDir),
    }).catch((error: Error) => {
      throw new Error(`skills/${basename(dir)}/${PATCH_FILE} no longer applies: ${error.message}`);
    });
  }
  return upstreamDir;
}

function describeSource(source: Source | undefined): string {
  if (!source) return "local";
  if ("command" in source) return `command \`${source.command}\``;
  return `git ${source.git}${source.path ? ` ${source.path}` : ""}${source.ref ? ` @ ${source.ref}` : ""}${source.into ? ` -> ${source.into}` : ""}`;
}

export async function resolveSkill(dir: string, workDir: string, git: GitCache): Promise<ResolvedSkill> {
  const name = basename(dir);
  const label = `skills/${name}/SKILL.md`;
  const local = parseSkillFile(await readFile(join(dir, "SKILL.md"), "utf8"), label);
  const { source: rawSource, targets: rawTargets, ...localFrontmatter } = local.frontmatter;
  if (localFrontmatter.name !== undefined && localFrontmatter.name !== name) {
    throw new Error(`${label}: name \`${localFrontmatter.name}\` must match its directory`);
  }
  const targets = parseTargets(rawTargets, label);
  const source = parseSource(rawSource, label);
  if (!source && (await exists(join(dir, PATCH_FILE)))) throw new Error(`${label}: ${PATCH_FILE} requires a source`);

  let upstream: SkillFile = { frontmatter: {}, body: "" };
  let files = new Map<string, FileEntry>();
  if (source) {
    const upstreamDir = await materializeUpstream(dir, source, workDir, git);
    const upstreamSkill = join(upstreamDir, "SKILL.md");
    if (await exists(upstreamSkill)) {
      upstream = parseSkillFile(await readFile(upstreamSkill, "utf8"), `${name} upstream SKILL.md`);
    }
    files = await listFiles(upstreamDir, false);
  }
  for (const [rel, entry] of await listFiles(dir, true)) files.set(rel, entry);

  const frontmatter: Frontmatter = { ...upstream.frontmatter, ...localFrontmatter, name };
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error(`${label}: description is required`);
  }
  const body = [upstream.body, local.body]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return { name, targets, frontmatter, body, files, origin: describeSource(source) };
}

function hasBinaryContent(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Write one consumer's copy of a skill into `dest`, which must not exist yet. */
export async function writeSkill(skill: ResolvedSkill, target: Target, dest: string): Promise<void> {
  const skillDir = skillDirFor(target, skill.name);
  const expand = (text: string) => text.replaceAll(SKILL_DIR_TOKEN, skillDir);
  await mkdir(dest, { recursive: true });

  for (const [rel, entry] of skill.files) {
    if (rel === CODEX_AGENT_FILE && target !== "codex") continue;
    const to = join(dest, rel);
    await mkdir(dirname(to), { recursive: true });
    const { mode } = await stat(entry.from);
    const bytes = await readFile(entry.from);
    if (entry.local && !hasBinaryContent(bytes) && bytes.toString("utf8").includes(SKILL_DIR_TOKEN)) {
      await writeFile(to, expand(bytes.toString("utf8")));
      await chmod(to, mode);
    } else {
      await copyFile(entry.from, to);
    }
  }

  if (target === "codex" && skill.frontmatter["disable-model-invocation"] === true) {
    const agentFile = join(dest, CODEX_AGENT_FILE);
    const existing = (await exists(agentFile)) ? Bun.YAML.parse(await readFile(agentFile, "utf8")) : undefined;
    const config = (existing ?? {}) as Record<string, Record<string, unknown>>;
    config.policy = { ...config.policy, allow_implicit_invocation: false };
    await mkdir(dirname(agentFile), { recursive: true });
    await writeFile(agentFile, `${stringifyYaml(config)}\n`);
  }

  const skillFile = renderSkillFile(targetFrontmatter(skill.frontmatter, target), skill.body);
  await writeFile(join(dest, "SKILL.md"), expand(skillFile));
  await writeFile(
    join(dest, MARKER_FILE),
    `Generated by ~/.pi/scripts/sync-skills.ts from ~/.pi/skills/${skill.name}; edit it there.\n`,
  );
}

async function listSkillDirs(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const withSkill = await Promise.all(
    dirs.map(async (entry) => ((await exists(join(sourceDir, entry.name, "SKILL.md"))) ? entry.name : undefined)),
  );
  return withSkill.filter(Boolean).map((name) => join(sourceDir, name));
}

export async function syncSkills(options: SyncOptions): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const result: SyncResult = { written: [], removed: [], warnings: [], errors: [] };
  const warn = (message: string) => {
    result.warnings.push(message);
    log(`warning: ${message}`);
  };
  const fail = (message: string) => {
    result.errors.push(message);
    log(`error: ${message}`);
  };
  const git = new GitCache(options.cacheDir, warn);
  const workDir = await mkdtemp(join(tmpdir(), "sync-skills-"));
  try {
    return await syncWith(options, result, git, workDir, warn, fail, log);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function syncWith(
  options: SyncOptions,
  result: SyncResult,
  git: GitCache,
  workDir: string,
  warn: (message: string) => void,
  fail: (message: string) => void,
  log: (message: string) => void,
): Promise<SyncResult> {
  const dirs = await listSkillDirs(resolve(options.sourceDir));
  const settled = await Promise.allSettled(dirs.map((dir) => resolveSkill(dir, workDir, git)));
  const skills: ResolvedSkill[] = [];
  /** Skills that failed locally keep their previous output until they are fixed. */
  const preserved = new Set<string>();
  settled.forEach((outcome, index) => {
    const name = basename(dirs[index]);
    if (outcome.status === "fulfilled") {
      skills.push(outcome.value);
      const unknown = Object.keys(outcome.value.frontmatter).filter((key) => !KNOWN_FIELDS.has(key));
      if (unknown.length) warn(`${name}: dropping unsupported frontmatter ${unknown.join(", ")}`);
    } else if (outcome.reason instanceof SourceError) {
      warn(`${name}: skipped, source unavailable: ${outcome.reason.message}`);
    } else {
      preserved.add(name);
      fail(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
    }
  });

  for (const target of TARGETS) {
    const configDir = join(options.home, TARGET_CONFIG_DIRS[target]);
    if (!(await exists(configDir))) {
      log(`${target}: ${configDir} does not exist, skipping`);
      continue;
    }
    const root = join(configDir, "skills");
    const staging = join(root, ".sync-staging");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    const wanted = skills.filter((skill) => skill.targets.includes(target));
    await Promise.all(
      wanted.map(async (skill) => {
        const dest = join(root, skill.name);
        if ((await exists(dest)) && !(await exists(join(dest, MARKER_FILE)))) {
          fail(`${target}: ${dest} exists but is not managed by sync-skills; move it into ~/.pi/skills or delete it`);
          return;
        }
        const staged = join(staging, skill.name);
        try {
          await writeSkill(skill, target, staged);
          await rm(dest, { recursive: true, force: true });
          await rename(staged, dest);
          result.written.push(`${target}/${skill.name}`);
        } catch (error) {
          fail(`${target}/${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    await rm(staging, { recursive: true, force: true });

    const wantedNames = new Set([...preserved, ...wanted.map((skill) => skill.name)]);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const dir = join(root, entry.name);
      if (!entry.isDirectory() || wantedNames.has(entry.name) || !(await exists(join(dir, MARKER_FILE)))) continue;
      await rm(dir, { recursive: true, force: true });
      result.removed.push(`${target}/${entry.name}`);
    }
  }

  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    const targets = skill.targets.filter((target) => result.written.includes(`${target}/${skill.name}`));
    log(`${skill.name}: ${skill.origin} -> ${targets.join(", ") || "nothing"}`);
  }
  for (const removed of result.removed) log(`removed ${removed}`);
  return result;
}

if (import.meta.main) {
  const home = homedir();
  const result = await syncSkills({
    sourceDir: resolve(import.meta.dir, "..", "skills"),
    home,
    cacheDir: join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "pi-skills"),
    log: (message) => console.log(`    ${message}`),
  });
  if (result.errors.length) process.exitCode = 1;
}
