import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  claudeStatus,
  copilotFromGh,
  type Exec,
  ensureProfileFiles,
  importAccountKey,
  PROFILE_NAMES,
  profileAuthPath,
  saveCopilot,
} from "../extensions/shared/accounts.js";

const agentDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, killed: Boolean(error?.killed), stdout, stderr });
    });
  });

// Installer entry point; outputs status only, never credentials or provider error bodies.
ensureProfileFiles(agentDir);
for (const profile of PROFILE_NAMES) {
  const runtime = await ModelRuntime.create({
    authPath: profileAuthPath(agentDir, profile),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const provider = profile === "work" ? "google" : "openrouter";
  try {
    await importAccountKey(runtime, agentDir, provider);
    console.log(`${profile}: ${provider} key configured`);
  } catch {
    console.error(`${profile}: unable to initialize ${provider}; check the injected secret file`);
    process.exitCode = 1;
  }
  if (profile === "work") {
    try {
      const copilot = runtime.getProvider("github-copilot");
      if (!copilot) throw new Error("No Copilot provider");
      const credential = await copilotFromGh(exec, copilot, AbortSignal.timeout(30_000));
      await saveCopilot(runtime, credential);
      console.log("work: Copilot connected using gh / drew-council");
    } catch {
      console.log("work: Copilot needs /log-me-in github-copilot (existing credentials preserved)");
    }
    const claude = await claudeStatus(exec);
    console.log(`work: Claude Code ${claude.loggedIn ? "is logged in" : "needs manual /login in Claude Code"}`);
  } else {
    try {
      const auth = await runtime.getAuth("openai-codex", { signal: AbortSignal.timeout(15_000) });
      console.log(`personal: Codex ${auth ? "saved login is ready" : "needs /log-me-in openai-codex"}`);
    } catch {
      console.log("personal: Codex needs /log-me-in openai-codex (saved credentials preserved)");
    }
  }
}
