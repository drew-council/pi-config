/**
 * Preloaded before every Bun test file (see `bunfig.toml`).
 *
 * Points the scratch extension at a throwaway root, so tests that load it, in
 * process or by spawning `pi`, never leave session directories in `/tmp/pi`.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchRoot = mkdtempSync(join(tmpdir(), "pi-test-scratch-"));
process.env.PI_SCRATCH_ROOT = scratchRoot;

afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
