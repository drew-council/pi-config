import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MARKER_FILE,
  parseSkillFile,
  renderSkillFile,
  syncSkills,
  targetFrontmatter,
} from "../../scripts/sync-skills.js";

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  assert.equal(result.exitCode, 0, result.stderr.toString());
}

async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sync-skills-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("each consumer receives only the frontmatter it understands", () => {
  const frontmatter = {
    name: "demo",
    description: "Demo skill.",
    compatibility: "Needs network.",
    "disable-model-invocation": true,
    "argument-hint": "<file>",
  };

  assert.deepEqual(Object.keys(targetFrontmatter(frontmatter, "pi")), [
    "name",
    "description",
    "compatibility",
    "disable-model-invocation",
  ]);
  assert.deepEqual(Object.keys(targetFrontmatter(frontmatter, "codex")), ["name", "description"]);
  assert.deepEqual(Object.keys(targetFrontmatter(frontmatter, "claude")), Object.keys(frontmatter));
});

test("rendered skill files parse back to the same frontmatter and body", () => {
  const frontmatter = { name: "demo", description: 'Use for "quoted": things.', metadata: { version: "0.1.0" } };
  const parsed = parseSkillFile(renderSkillFile(frontmatter, "# Demo\n\nBody.\n"), "demo");

  assert.deepEqual(parsed.frontmatter, frontmatter);
  assert.equal(parsed.body, "# Demo\n\nBody.\n");
});

test("sync generates per-consumer skills from local, command, and git sources", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const sourceDir = join(root, "skills");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });

    await write(
      join(sourceDir, "local-tool", "SKILL.md"),
      "---\nname: local-tool\ndescription: Local tool.\ndisable-model-invocation: true\ncompatibility: Needs x.\n---\n\nRun `{{skillDir}}/scripts/run.sh`.\n",
    );
    await write(join(sourceDir, "local-tool", "scripts", "run.sh"), "#!/bin/sh\necho {{skillDir}}\n");
    await write(join(sourceDir, "local-tool", "agents", "openai.yaml"), "interface:\n  display_name: Local Tool\n");

    await write(
      join(sourceDir, "from-command", "SKILL.md"),
      "---\ndisable-model-invocation: true\ntargets: [pi]\nsource:\n  command: cat ../upstream.md\n---\n\nLocal addendum.\n",
    );
    // Commands run in the skill's directory; keep this fixture outside it so it is not copied.
    await write(
      join(sourceDir, "upstream.md"),
      "---\nname: upstream-name\ndescription: Upstream.\n---\n\nUpstream body.\nRemove me.\n",
    );
    await write(
      join(sourceDir, "from-command", "upstream.patch"),
      "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -5,2 +5 @@\n Upstream body.\n-Remove me.\n",
    );

    const upstreamRepo = join(root, "upstream");
    await write(
      join(upstreamRepo, "skills", "remote", "SKILL.md"),
      "---\nname: remote\ndescription: Remote.\n---\n\nRemote body.\n",
    );
    await write(join(upstreamRepo, "skills", "remote", "references", "guide.md"), "Guide {{skillDir}}\n");
    git(upstreamRepo, "init", "-q");
    git(upstreamRepo, "add", ".");
    git(upstreamRepo, "commit", "-qm", "init");
    await write(
      join(sourceDir, "remote", "SKILL.md"),
      `---\nname: remote\nsource:\n  git: ${upstreamRepo}\n  path: skills/remote\n---\n`,
    );

    const result = await syncSkills({ sourceDir, home, cacheDir: join(root, "cache") });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.written.sort(), [
      "codex/local-tool",
      "codex/remote",
      "pi/from-command",
      "pi/local-tool",
      "pi/remote",
    ]);

    const piLocal = await readFile(join(home, ".pi/agent/skills/local-tool/SKILL.md"), "utf8");
    assert.match(piLocal, /disable-model-invocation: true/);
    assert.match(piLocal, /Run `~\/\.pi\/agent\/skills\/local-tool\/scripts\/run\.sh`/);
    assert.equal(
      await readFile(join(home, ".codex/skills/local-tool/scripts/run.sh"), "utf8"),
      "#!/bin/sh\necho ~/.codex/skills/local-tool\n",
    );
    assert.ok(await exists(join(home, ".pi/agent/skills/local-tool", MARKER_FILE)));
    assert.ok(!(await exists(join(home, ".pi/agent/skills/local-tool/agents/openai.yaml"))));

    const codexLocal = parseSkillFile(await readFile(join(home, ".codex/skills/local-tool/SKILL.md"), "utf8"), "x");
    assert.deepEqual(codexLocal.frontmatter, { name: "local-tool", description: "Local tool." });
    assert.deepEqual(
      Bun.YAML.parse(await readFile(join(home, ".codex/skills/local-tool/agents/openai.yaml"), "utf8")),
      {
        interface: { display_name: "Local Tool" },
        policy: { allow_implicit_invocation: false },
      },
    );

    const fromCommand = parseSkillFile(
      await readFile(join(home, ".pi/agent/skills/from-command/SKILL.md"), "utf8"),
      "x",
    );
    assert.deepEqual(fromCommand.frontmatter, {
      name: "from-command",
      description: "Upstream.",
      "disable-model-invocation": true,
    });
    assert.equal(fromCommand.body, "Upstream body.\n\nLocal addendum.\n");
    assert.ok(!(await exists(join(home, ".pi/agent/skills/from-command/upstream.patch"))));

    // Upstream files are copied verbatim, without expanding placeholders.
    assert.equal(
      await readFile(join(home, ".pi/agent/skills/remote/references/guide.md"), "utf8"),
      "Guide {{skillDir}}\n",
    );
    assert.match(await readFile(join(home, ".codex/skills/remote/SKILL.md"), "utf8"), /Remote body\./);
  });
});

test("sync removes stale and unavailable skills but never unmanaged directories", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const sourceDir = join(root, "skills");
    const skillsDir = join(home, ".pi", "agent", "skills");
    const options = { sourceDir, home, cacheDir: join(root, "cache") };
    await write(join(sourceDir, "keep", "SKILL.md"), "---\ndescription: Keep.\n---\n\nKeep.\n");
    await write(
      join(sourceDir, "missing-tool", "SKILL.md"),
      "---\nsource:\n  command: definitely-not-a-command-xyz\n---\n",
    );
    await write(join(sourceDir, "broken", "SKILL.md"), "---\ndescription: Broken.\n---\n");
    await write(join(skillsDir, "missing-tool", MARKER_FILE), "");
    await write(join(skillsDir, "stale", MARKER_FILE), "");
    await write(join(skillsDir, "hand-made", "SKILL.md"), "---\ndescription: Mine.\n---\n");
    await write(join(skillsDir, "broken", MARKER_FILE), "");
    await write(join(skillsDir, "broken", "SKILL.md"), "previous output\n");
    await write(join(sourceDir, "broken", "SKILL.md"), "---\nname: wrong-name\ndescription: Broken.\n---\n");

    const result = await syncSkills(options);

    assert.deepEqual(result.written, ["pi/keep"]);
    assert.deepEqual(result.removed.sort(), ["pi/missing-tool", "pi/stale"]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /missing-tool: skipped, source unavailable/);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /must match its directory/);
    assert.ok(await exists(join(skillsDir, "hand-made", "SKILL.md")));
    assert.equal(await readFile(join(skillsDir, "broken", "SKILL.md"), "utf8"), "previous output\n");

    await write(join(sourceDir, "hand-made", "SKILL.md"), "---\ndescription: Now managed.\n---\n");
    const conflict = await syncSkills(options);
    assert.ok(conflict.errors.some((error) => /hand-made exists but is not managed/.test(error)));
    assert.equal(await readFile(join(skillsDir, "hand-made", "SKILL.md"), "utf8"), "---\ndescription: Mine.\n---\n");
  });
});
