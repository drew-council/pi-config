import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const STARTUP_TIMEOUT_MS = 60_000;

// Startup can stall on the 30-second refresh queue wait.
// Outlast the inner kill timer so its diagnostics surface.
test(
  "the installed Pi runtime starts successfully with discovered extensions",
  { timeout: STARTUP_TIMEOUT_MS + 5_000 },
  async () => {
    const child = spawn(
      "pi",
      [
        "--offline",
        "--mode",
        "rpc",
        "--no-session",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, PI_OFFLINE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.end(`${JSON.stringify({ type: "get_state" })}\n`);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`Pi startup did not exit within ${STARTUP_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
      }, STARTUP_TIMEOUT_MS);

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    const output = `${stdout}\n${stderr}`;
    assert.deepEqual(exit, { code: 0, signal: null }, `Pi startup failed:\n${output}`);
    assert.doesNotMatch(output, /Failed to load extension|does not export a valid factory function/i);

    const stateResponse = stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; command?: string; success?: boolean };
        } catch {
          return undefined;
        }
      })
      .find((message) => message?.type === "response" && message.command === "get_state");
    assert.equal(stateResponse?.success, true, `Pi did not answer get_state successfully:\n${output}`);
  },
);
