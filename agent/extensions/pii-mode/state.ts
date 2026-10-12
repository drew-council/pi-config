import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type PiiModeConfig } from "./policy.js";

/**
 * The process-wide switch, and the contract with everything else: pi processes
 * started from this one inherit it and start in PII-safe mode, and extensions
 * that persist user content on their own skip doing so while it is "1".
 */
export const PII_ENV = "PI_PII_MODE";
export const isActive = (): boolean => process.env[PII_ENV] === "1";

type PiiState = {
  config: PiiModeConfig;
  configError?: string;
  /** Pi internals the guards could not find; PII-safe mode refuses to run without them. */
  missing: string[];
  scratchDir?: string;
  previousTmpDir?: string;
  exitHook?: boolean;
  swept?: boolean;
};

// Process-global so session replacement and /reload, which load a new copy of
// this extension, share one switch, one scratch directory and one exit hook.
const STATE = Symbol.for("pi.pii-mode.state");
export function piiState(): PiiState {
  const host = globalThis as typeof globalThis & { [STATE]?: PiiState };
  host[STATE] ??= { config: DEFAULT_CONFIG, missing: [] };
  return host[STATE];
}

const SCRATCH_PREFIX = "pi-pii-";

/**
 * Points TMPDIR at a new private (0700) directory, so pi's saved tool output,
 * editor temp files and `mktemp` in bash land somewhere deleted on exit.
 * Node's os.tmpdir() and pi's shell environment read TMPDIR on every call.
 */
export function enterScratchDir(): string {
  const state = piiState();
  if (state.scratchDir) return state.scratchDir;
  const base = tmpdir();
  removeStaleScratchDirs(base);
  state.previousTmpDir = process.env.TMPDIR;
  state.scratchDir = mkdtempSync(join(base, `${SCRATCH_PREFIX}${process.pid}-`));
  // Bun's mkdtemp, unlike Node's, does not create the directory 0700.
  chmodSync(state.scratchDir, 0o700);
  process.env.TMPDIR = state.scratchDir;
  if (!state.exitHook) {
    process.once("exit", leaveScratchDir);
    state.exitHook = true;
  }
  return state.scratchDir;
}

export function leaveScratchDir(): void {
  const state = piiState();
  if (!state.scratchDir) return;
  rmSync(state.scratchDir, { recursive: true, force: true });
  if (process.env.TMPDIR === state.scratchDir) {
    if (state.previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = state.previousTmpDir;
  }
  state.scratchDir = undefined;
  state.previousTmpDir = undefined;
}

/**
 * Runs once per process, in or out of PII-safe mode. A child that inherited
 * TMPDIR and outlived its pi process (pi's own `npm root -g` lookup, a
 * background job started from bash) can recreate the directory after the exit
 * cleanup, so the next pi start removes it.
 */
export function sweepStaleScratchDirs(): void {
  const state = piiState();
  if (state.swept) return;
  state.swept = true;
  removeStaleScratchDirs(tmpdir());
}

/** Deletes scratch directories whose pi process has exited (normally, crashed or killed). */
export function removeStaleScratchDirs(base: string): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(new RegExp(`^${SCRATCH_PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (!pid || processAlive(pid)) continue;
    try {
      rmSync(join(base, name), { recursive: true, force: true });
    } catch {
      // Another user's directory in a shared /tmp; not ours to remove.
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Turns the switch on and returns how to undo it, for an entry that could not complete. */
export function activate(): () => void {
  process.env[PII_ENV] = "1";
  enterScratchDir();
  return () => {
    leaveScratchDir();
    delete process.env[PII_ENV];
  };
}
