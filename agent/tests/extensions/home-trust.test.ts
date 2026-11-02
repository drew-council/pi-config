import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findDecision, normalizeTrust } from "../../extensions/home-trust.js";

test("home-relative and absolute keys apply to the cwd and its descendants", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-home-trust-")));
  try {
    const project = join(home, "work", "repo", "nested");
    mkdirSync(project, { recursive: true });
    assert.equal(findDecision({ "~/work": true }, project, home), true);
    assert.equal(findDecision({ "~/work": true, "~/work/repo": false }, project, home), false);
    assert.equal(findDecision({ [join(home, "work", "repo")]: true }, project, home), true);
    assert.equal(findDecision({ "~/other": true }, project, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("normalization contracts home paths, keeps the absolute value on conflict, and drops nulls", () => {
  const home = "/home/user";
  assert.deepEqual(
    normalizeTrust(
      {
        "/home/user/b": true,
        "~/a": true,
        "~/c": true,
        "/home/user/c": false,
        "/home/user/d": null,
        "/home/user2/e": true,
        "/opt/project": true,
      },
      home,
    ),
    { "/home/user2/e": true, "/opt/project": true, "~/a": true, "~/b": true, "~/c": false },
  );
});
