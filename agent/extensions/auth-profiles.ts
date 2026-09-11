import type { Api, AuthInteraction, AuthPrompt, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  LoginDialogComponent,
  type ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  ACCOUNTS,
  type Account,
  bindRuntimeProfile,
  chooseProfileModel,
  claudeStatus,
  copilotFromGh,
  ensureProfileFiles,
  importAccountKey,
  isProfileName,
  PROFILE_NAMES,
  type ProfileName,
  profileAuthPath,
  providerAllowed,
  providersFor,
  readActiveProfile,
  readJson,
  saveCopilot,
  verifyGitHubAccount,
  writeActiveProfile,
} from "./shared/accounts.js";
import { installProfilePolicy, installScopedModelPolicy } from "./shared/profile-policy.js";

export function getRuntime(registry: ModelRegistry): ModelRuntime {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime || typeof runtime.login !== "function")
    throw new Error("Pi's model registry API changed; update auth-profiles.");
  return runtime;
}

async function closeProviderSessions(): Promise<void> {
  const ai = await import("@earendil-works/pi-ai");
  ai.cleanupSessionResources();
}

function refreshRegistryInBackground(
  registry: Pick<ModelRegistry, "refresh">,
  providers: readonly string[],
  cleanup: () => Promise<void> = closeProviderSessions,
  timeoutMs = 1_000,
  after: () => Promise<void> = async () => {},
): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  // Never let provider refresh hold up session_start or TUI initialization.
  void Promise.resolve()
    .then(cleanup)
    .then(() => registry.refresh({ allowNetwork: false, providers, signal: controller.signal }))
    .then(after)
    .catch(() => {})
    .finally(() => clearTimeout(timeout));
}

async function withProgress<T>(
  ctx: ExtensionContext,
  title: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, title);
    // Wait for the task to settle before returning, so a cancelled write cannot
    // overlap a later profile switch. All I/O also has a bounded deadline.
    const signal = AbortSignal.any([loader.signal, AbortSignal.timeout(30_000)]);
    void run(signal)
      .then((value) => done(value))
      .catch(() => done(undefined));
    return loader;
  });
}

export async function promptWithSignal(
  dialog: Pick<LoginDialogComponent, "showManualInput" | "showPrompt">,
  prompt: AuthPrompt,
): Promise<string> {
  if (prompt.type === "secret" || prompt.type === "select") throw new Error("Unexpected OAuth prompt type.");
  prompt.signal?.throwIfAborted();
  const response =
    prompt.type === "manual_code"
      ? dialog.showManualInput(prompt.message)
      : dialog.showPrompt(prompt.message, prompt.placeholder);
  if (!prompt.signal) return response;
  const signal = prompt.signal;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Login cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([response, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function oauthLogin(
  runtime: ModelRuntime,
  ctx: ExtensionContext,
  account: Account,
  shutdown: AbortSignal,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
    const dialog = new LoginDialogComponent(tui, account.id, () => {}, account.label);
    const signal = AbortSignal.any([dialog.signal, shutdown, AbortSignal.timeout(600_000)]);
    const interaction: AuthInteraction = {
      signal,
      prompt: (prompt) =>
        promptWithSignal(dialog, {
          ...prompt,
          signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal,
        }),
      notify: (event) => {
        if (signal.aborted) return;
        if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
        else if (event.type === "device_code") {
          dialog.showDeviceCode(event);
          dialog.showWaiting("Authorize drew-council in your browser; Esc cancels.");
        } else if (event.type === "info") dialog.showInfo(event.message, event.links);
        else dialog.showProgress(event.message);
      },
    };
    const login = async () => {
      if (account.id !== "github-copilot") {
        await runtime.login(account.id, "oauth", interaction);
        return;
      }
      const oauth = runtime.getProvider(account.id)?.auth.oauth;
      if (!oauth) throw new Error("Copilot OAuth unavailable");
      const credential = await oauth.login({ ...interaction, signal });
      await verifyGitHubAccount(credential.refresh, signal);
      await saveCopilot(runtime, credential, signal);
    };
    void login()
      .then(() => done(true))
      .catch(() => done(false));
    return dialog;
  });
}

export default function authProfiles(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let activeProfile = readActiveProfile(agentDir);
  let busy = false;
  const shutdown = new AbortController();
  const remembered = new Map<ProfileName, Model<Api>>();
  // Installed during discovery, before the first interactive picker/request.
  installProfilePolicy(ModelRuntime.prototype, () => activeProfile);
  installScopedModelPolicy(AgentSession.prototype);

  const setStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus("auth-profile", ctx.ui.theme.fg("accent", `profile: ${activeProfile}`));
  const ensureModel = async (ctx: ExtensionContext) => {
    if (ctx.model && providerAllowed(activeProfile, ctx.model.provider)) return;
    const next = chooseProfileModel(ctx.modelRegistry.getAvailable(), activeProfile, remembered.get(activeProfile));
    if (next) await pi.setModel(next);
    else
      ctx.ui.notify(
        `No available ${activeProfile} model. Run /log-me-in. The previous provider is blocked.`,
        "warning",
      );
  };
  const switchProfile = async (ctx: ExtensionContext, profile: ProfileName) => {
    if (ctx.model && providerAllowed(activeProfile, ctx.model.provider)) remembered.set(activeProfile, ctx.model);
    bindRuntimeProfile(getRuntime(ctx.modelRegistry), agentDir, profile);
    activeProfile = profile;
    process.env.PI_AUTH_PROFILE = profile; // spawned Pi/subagents inherit this session's profile
    writeActiveProfile(agentDir, profile);
    setStatus(ctx);
    await closeProviderSessions();
    await ctx.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(2_000) }).catch(() => {});
    await ensureModel(ctx);
    pi.events.emit("auth-profile:changed", { profile });
  };

  pi.on("session_start", (_event, ctx) => {
    ensureProfileFiles(agentDir);
    bindRuntimeProfile(getRuntime(ctx.modelRegistry), agentDir, activeProfile);
    process.env.PI_AUTH_PROFILE = activeProfile;
    setStatus(ctx);
    refreshRegistryInBackground(
      ctx.modelRegistry,
      providersFor(activeProfile),
      closeProviderSessions,
      1_000,
      async () => {
        if (!shutdown.signal.aborted) await ensureModel(ctx);
      },
    );
  });
  pi.on("session_shutdown", () => {
    shutdown.abort();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await ensureModel(ctx);
  });

  pi.registerCommand("profile", {
    description: "Switch work/personal accounts and the native model picker",
    getArgumentCompletions: (prefix) =>
      [...PROFILE_NAMES, "status"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (busy) {
        ctx.ui.notify("Finish or cancel /log-me-in first.", "warning");
        return;
      }
      await ctx.waitForIdle();
      const requested = args.trim();
      if (requested === "status") {
        ctx.ui.notify(
          `${activeProfile}: ${providersFor(activeProfile).join(", ")}\nCredentials: ${profileAuthPath(agentDir, activeProfile)}`,
          "info",
        );
        return;
      }
      const selected =
        requested ||
        (ctx.hasUI
          ? await ctx.ui.select("Select account profile (conversation is retained)", [...PROFILE_NAMES])
          : undefined);
      if (!selected) return;
      if (!isProfileName(selected)) {
        ctx.ui.notify("Usage: /profile [work|personal|status]", "warning");
        return;
      }
      if (selected === activeProfile) return;
      busy = true;
      try {
        await switchProfile(ctx, selected);
      } finally {
        busy = false;
      }
    },
  });

  const loginAccount = async (account: Account, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx.modelRegistry);
    if (account.id === "claude-bridge") {
      while (true) {
        const status = await claudeStatus(pi.exec.bind(pi));
        if (status.loggedIn) {
          ctx.ui.notify(`Claude Code: ${status.detail}`, "info");
          return;
        }
        const choice = await ctx.ui.select(status.detail, ["Recheck Claude Code", "Back"]);
        if (choice !== "Recheck Claude Code") return;
      }
    }
    if (account.id === "google" || account.id === "openrouter") {
      try {
        await importAccountKey(runtime, agentDir, account.id);
        ctx.ui.notify(`${account.label}: configured from the local 1Password-injected secret file.`, "info");
      } catch {
        ctx.ui.notify(
          `Run ~/.pi/scripts/install.nu to initialize ${account.profile} secrets, then select this account again.`,
          "warning",
        );
      }
      return;
    }
    if (account.id === "github-copilot") {
      const action = await ctx.ui.select("Copilot · drew-council", [
        "Connect using gh (no browser)",
        "Browser login",
        "Check saved login",
      ]);
      if (!action) return;
      if (action === "Connect using gh (no browser)") {
        const success = await withProgress(ctx, "Connecting Copilot through gh…", async (signal) => {
          const provider = runtime.getProvider(account.id);
          if (!provider) throw new Error("Missing provider");
          const credential = await copilotFromGh(pi.exec.bind(pi), provider, signal);
          signal.throwIfAborted();
          await saveCopilot(runtime, credential, signal);
          return true;
        });
        ctx.ui.notify(
          success
            ? "Copilot connected as drew-council."
            : "Could not connect using gh (or cancelled). Check gh auth login, or choose Browser login.",
          success ? "info" : "warning",
        );
        return;
      }
      if (action === "Browser login") {
        const ok = await oauthLogin(runtime, ctx, account, shutdown.signal);
        ctx.ui.notify(
          ok
            ? "Copilot login saved."
            : "Login cancelled or failed; previous credentials were preserved unless login completed before cancellation.",
          ok ? "info" : "warning",
        );
        return;
      }
    } else {
      const action = await ctx.ui.select(account.label, ["Check saved login", "Browser login / reauthenticate"]);
      if (!action) return;
      if (action !== "Check saved login") {
        const ok = await oauthLogin(runtime, ctx, account, shutdown.signal);
        ctx.ui.notify(
          ok ? "Codex login saved." : "Login cancelled or failed. Try again when ready.",
          ok ? "info" : "warning",
        );
        return;
      }
    }
    const ok = await withProgress(ctx, `Checking ${account.label}…`, async (signal) =>
      Boolean(await runtime.getAuth(account.id, { signal })),
    );
    ctx.ui.notify(
      ok
        ? "Saved login resolves successfully."
        : "No usable saved login (or check cancelled). Choose Browser login to authenticate.",
      ok ? "info" : "warning",
    );
  };

  pi.registerCommand("log-me-in", {
    description: "Account login menu: work (Copilot/Gemini/Claude) and personal (Codex/OpenRouter)",
    getArgumentCompletions: (prefix) =>
      ACCOUNTS.filter((a) => a.id.startsWith(prefix)).map((a) => ({ value: a.id, label: `${a.profile}: ${a.label}` })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/log-me-in needs interactive Pi. Use scripts/install.nu for unattended setup.", "warning");
        return;
      }
      if (busy) return;
      await ctx.waitForIdle();
      busy = true;
      try {
        const requested = args.trim();
        if (requested && !ACCOUNTS.some((account) => account.id === requested)) {
          ctx.ui.notify(`Usage: /log-me-in [${ACCOUNTS.map((a) => a.id).join("|")}]`, "warning");
          return;
        }
        do {
          const choices = ACCOUNTS.map((account) => {
            const saved = readJson(profileAuthPath(agentDir, account.profile))[account.id];
            const state =
              account.id === "claude-bridge"
                ? "check in Claude Code"
                : saved
                  ? "configured · select to check/reconnect"
                  : "setup needed";
            return `${account.profile}${account.profile === activeProfile ? " *" : ""} · ${account.label} — ${state}`;
          });
          const choice = requested
            ? undefined
            : await ctx.ui.select("Log me in · select an account · Esc closes", choices);
          const account = requested
            ? ACCOUNTS.find((a) => a.id === requested)
            : ACCOUNTS[choices.indexOf(choice ?? "")];
          if (!account) return;
          if (account.profile !== activeProfile) {
            if (
              !(await ctx.ui.confirm(
                `Switch to ${account.profile}?`,
                "This changes the available providers and active model. The current conversation is retained; use /new if it should not cross accounts.",
              ))
            )
              continue;
            await switchProfile(ctx, account.profile);
          }
          await loginAccount(account, ctx);
          await ensureModel(ctx);
        } while (!requested);
      } catch {
        ctx.ui.notify(
          "Account setup failed. Check local configuration and retry; credential details were not logged.",
          "error",
        );
      } finally {
        busy = false;
      }
    },
  });
}

export const _test = { refreshRegistryInBackground };
