import {
  type Api,
  type AuthInteraction,
  type AuthPrompt,
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  LoginDialogComponent,
  type ModelRegistry,
  type ModelRuntime,
  parseArgs,
} from "@earendil-works/pi-coding-agent";
import {
  ACCOUNTS,
  type Account,
  accountScope,
  bindRuntimeProfile,
  chooseProfileModel,
  claudeStatus,
  copilotFromGh,
  ensureProfileFiles,
  hasVertexAdc,
  importAccountKey,
  importMissingAccountKey,
  isProfileName,
  PROFILE_NAMES,
  type ProfileName,
  profileAuthPath,
  profileForDirectory,
  providerAllowed,
  providersFor,
  readActiveProfile,
  readJson,
  runtimeStore,
  saveCopilot,
  saveVertex,
  VERTEX_ENV,
  verifyGitHubAccount,
  writeActiveProfile,
} from "../shared/accounts.js";
import { showModelEffortPicker } from "./picker.js";
import { type ModelEffortPreference, readProfileDefault, writeProfileDefault } from "./preferences.js";
import { installRuntimeAdapters, installStartupProfileBinding } from "./runtime-adapter.js";
import { createActualUseRecorder, readRecentUsage } from "./usage.js";

export function getRuntime(registry: ModelRegistry): ModelRuntime {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime || typeof runtime.login !== "function")
    throw new Error("Pi's model registry API changed; update model-control.");
  return runtime;
}

async function closeProviderSessions(): Promise<void> {
  const ai = await import("@earendil-works/pi-ai");
  ai.cleanupSessionResources();
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

type PairContext = Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">;
export type AppliedProfileDefault = { pair: ModelEffortPreference; usedFallback: boolean };

export function currentPair(ctx: PairContext): ModelEffortPreference | undefined {
  return ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
}

export function pairIsAvailable(ctx: PairContext, pair: ModelEffortPreference): boolean {
  const model = ctx.modelRegistry
    .getAvailable()
    .find((candidate) => candidate.provider === pair.provider && candidate.id === pair.model);
  return Boolean(model && clampThinkingLevel(model, pair.thinking) === pair.thinking);
}

export async function applyModelEffortPair(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">,
  ctx: PairContext,
  model: Model<Api>,
  thinking: ModelThinkingLevel,
): Promise<ModelEffortPreference | undefined> {
  if (!ctx.model || ctx.model.provider !== model.provider || ctx.model.id !== model.id) {
    if (!(await pi.setModel(model))) return undefined;
  }
  const effectiveThinking = clampThinkingLevel(model, thinking);
  pi.setThinkingLevel(effectiveThinking);
  return { provider: model.provider, model: model.id, thinking: effectiveThinking };
}

export async function applyProfileDefault(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">,
  ctx: PairContext,
  profile: ProfileName,
  preference = readProfileDefault(getAgentDir(), profile),
): Promise<AppliedProfileDefault> {
  let available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    throw new Error(
      `No ${profile} model is available: none of ${providersFor(profile).join(", ")} has a saved login in ${profileAuthPath(getAgentDir(), profile)}. Run /log-me-in (or ~/.pi/scripts/install.nu) to connect one.`,
    );
  }
  const exact = available.find((model) => model.provider === preference.provider && model.id === preference.model);
  const rejected: string[] = [];
  let next = exact ?? chooseProfileModel(available, profile);
  while (next) {
    const applied = await applyModelEffortPair(pi, ctx, next, preference.thinking);
    if (applied) return { pair: applied, usedFallback: next !== exact || applied.thinking !== preference.thinking };
    rejected.push(next.provider);
    available = available.filter((model) => model.provider !== next?.provider);
    next = chooseProfileModel(available, profile);
  }
  throw new Error(
    `No usable ${profile} model: Pi rejected the saved login for ${rejected.join(", ")}. Run /log-me-in.`,
  );
}

export async function ensureProfilePair(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">,
  ctx: PairContext,
  profile: ProfileName,
  preference = readProfileDefault(getAgentDir(), profile),
): Promise<AppliedProfileDefault | undefined> {
  const pair = currentPair(ctx);
  if (pair && pairIsAvailable(ctx, pair) && providerAllowed(profile, pair.provider)) return undefined;
  return applyProfileDefault(pi, ctx, profile, preference);
}

export function thinkingFromModelArgument(model: string | undefined): ModelThinkingLevel | undefined {
  const level = model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1];
  return level as ModelThinkingLevel | undefined;
}

export function shouldPreserveSessionPair(
  reason: "startup" | "reload" | "new" | "resume" | "fork",
  startup: { explicitPair: boolean; restoresSession: boolean; inheritedProfile: boolean },
): boolean {
  return (
    reason === "reload" ||
    reason === "resume" ||
    reason === "fork" ||
    (reason === "startup" && (startup.explicitPair || startup.restoresSession || startup.inheritedProfile))
  );
}

export async function runProfileSwitchTransaction(options: {
  previousProfile: ProfileName;
  targetProfile: ProfileName;
  prepare(profile: ProfileName): Promise<void>;
  refresh(profile: ProfileName): Promise<unknown>;
  login?: () => Promise<void>;
  applyDefault(profile: ProfileName): Promise<unknown>;
  rollback(profile: ProfileName): Promise<void> | void;
  restorePair(): Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await options.prepare(options.targetProfile);
    await options.refresh(options.targetProfile);
    if (options.login) {
      await options.login();
      await options.refresh(options.targetProfile);
    }
    await options.applyDefault(options.targetProfile);
    return { ok: true };
  } catch (error) {
    await options.rollback(options.previousProfile);
    await options.refresh(options.previousProfile).catch(() => {});
    await options.restorePair().catch(() => {});
    return { ok: false, error };
  }
}

export default function modelControl(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  ensureProfileFiles(agentDir);
  const inheritedProfile = isProfileName(process.env.PI_AUTH_PROFILE) ? process.env.PI_AUTH_PROFILE : undefined;
  let activeProfile = inheritedProfile ?? profileForDirectory(process.cwd()) ?? readActiveProfile(agentDir);
  let busy = false;
  const usageRecorder = createActualUseRecorder(agentDir, () => activeProfile);
  const shutdown = new AbortController();
  let args: ReturnType<typeof parseArgs> | undefined;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    args = undefined;
  }
  const startupHasExplicitPair = Boolean(args?.provider || args?.model || args?.thinking);
  const startupExplicitThinking = args?.thinking ?? thinkingFromModelArgument(args?.model);
  const startupRestoresSession = Boolean(args?.continue || args?.resume || args?.session || args?.fork);

  process.env.PI_AUTH_PROFILE = activeProfile;

  const setStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus("auth-profile", ctx.ui.theme.fg("accent", `profile: ${activeProfile}`));
  const notifyFallback = (ctx: ExtensionContext, profile: ProfileName, result: AppliedProfileDefault | undefined) => {
    if (!result?.usedFallback) return;
    ctx.ui.notify(
      `${profile} default is unavailable; using ${result.pair.provider}/${result.pair.model}:${result.pair.thinking}.`,
      "warning",
    );
  };
  const applyDefault = async (ctx: ExtensionContext, profile: ProfileName) => {
    const result = await applyProfileDefault(pi, ctx, profile, readProfileDefault(agentDir, profile));
    notifyFallback(ctx, profile, result);
    return result;
  };
  const ensurePair = async (ctx: ExtensionContext) => {
    const result = await ensureProfilePair(pi, ctx, activeProfile, readProfileDefault(agentDir, activeProfile));
    notifyFallback(ctx, activeProfile, result);
    return result;
  };
  const refreshProfile = (ctx: ExtensionContext, profile: ProfileName) =>
    ctx.modelRegistry.refresh({
      providers: providersFor(profile),
      allowNetwork: false,
      signal: AbortSignal.timeout(5_000),
    });
  const prepareProfile = async (ctx: ExtensionContext, profile: ProfileName) => {
    activeProfile = profile;
    const runtime = getRuntime(ctx.modelRegistry);
    await closeProviderSessions();
    bindRuntimeProfile(runtime, agentDir, profile);
    await importMissingAccountKey(runtime, agentDir, profile);
  };
  const restorePair = async (ctx: ExtensionContext, pair: ModelEffortPreference | undefined) => {
    const model = pair
      ? ctx.modelRegistry
          .getAvailable()
          .find((candidate) => candidate.provider === pair.provider && candidate.id === pair.model)
      : undefined;
    if (model && pair) {
      const restored = await applyModelEffortPair(pi, ctx, model, pair.thinking);
      if (restored) return;
    }
    await applyDefault(ctx, activeProfile);
  };

  installRuntimeAdapters({
    agentDir,
    getProfile: () => activeProfile,
    getPreference: (profile) => readProfileDefault(agentDir, profile),
    savePreference: (profile, preference) => writeProfileDefault(agentDir, profile, preference),
    openPicker: async (ctx, initialSearchInput) => {
      const result = await showModelEffortPicker({
        ctx,
        profile: activeProfile,
        defaultPair: readProfileDefault(agentDir, activeProfile),
        recent: readRecentUsage(agentDir, activeProfile),
        initialSearchInput,
        providers: providersFor(activeProfile),
      });
      if (!result) return;
      const applied = await applyModelEffortPair(pi, ctx, result.pair.modelObject, result.pair.thinking);
      if (!applied) throw new Error(`Could not select ${result.pair.provider}/${result.pair.model}.`);
      if (result.save) {
        writeProfileDefault(agentDir, activeProfile, applied);
        ctx.ui.notify(
          `Saved ${activeProfile} default: ${applied.provider}/${applied.model}:${applied.thinking}`,
          "info",
        );
      }
    },
  });

  /** Switch accounts, applying the destination default and rolling back as one operation. */
  const switchProfile = async (
    ctx: ExtensionContext,
    profile: ProfileName,
    login?: (ctx: ExtensionContext) => Promise<void>,
  ) => {
    const previousProfile = activeProfile;
    const previousPair = currentPair(ctx);
    const switched = await runProfileSwitchTransaction({
      previousProfile,
      targetProfile: profile,
      prepare: (target) => prepareProfile(ctx, target),
      refresh: (target) => refreshProfile(ctx, target),
      login: login ? () => login(ctx) : undefined,
      applyDefault: (target) => applyDefault(ctx, target),
      rollback: (target) => {
        activeProfile = target;
        bindRuntimeProfile(getRuntime(ctx.modelRegistry), agentDir, target);
      },
      restorePair: () => restorePair(ctx, previousPair),
    });
    if ("error" in switched) {
      const reason =
        switched.error instanceof Error && switched.error.message
          ? switched.error.message
          : `Could not switch to ${profile}.`;
      ctx.ui.notify(`Staying on ${previousProfile}. ${reason}`, "error");
      setStatus(ctx);
      return false;
    }
    process.env.PI_AUTH_PROFILE = profile;
    writeActiveProfile(agentDir, profile);
    setStatus(ctx);
    pi.events.emit("auth-profile:changed", { profile });
    return true;
  };

  pi.on("session_start", async (event, ctx) => {
    try {
      const startupProfile = event.reason === "startup" ? profileForDirectory(ctx.cwd) : undefined;
      if (!inheritedProfile && startupProfile && startupProfile !== activeProfile) {
        await prepareProfile(ctx, startupProfile);
        await refreshProfile(ctx, startupProfile);
      } else {
        const runtime = getRuntime(ctx.modelRegistry);
        if (runtimeStore(runtime).authPath !== profileAuthPath(agentDir, activeProfile)) {
          await prepareProfile(ctx, activeProfile);
          await refreshProfile(ctx, activeProfile);
        }
      }
      process.env.PI_AUTH_PROFILE = activeProfile;
      setStatus(ctx);

      const preserve = shouldPreserveSessionPair(event.reason, {
        explicitPair: startupHasExplicitPair,
        restoresSession: startupRestoresSession,
        inheritedProfile: inheritedProfile === activeProfile,
      });
      if (event.reason === "new" || !preserve) {
        await applyDefault(ctx, activeProfile);
      } else {
        if (event.reason === "startup" && startupHasExplicitPair && !startupExplicitThinking && ctx.model) {
          await applyModelEffortPair(pi, ctx, ctx.model, readProfileDefault(agentDir, activeProfile).thinking);
        }
        await ensurePair(ctx);
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
  pi.on("session_shutdown", () => {
    shutdown.abort();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await ensurePair(ctx);
    usageRecorder.markPending();
  });
  pi.on("before_provider_request", (_event, ctx) => {
    try {
      usageRecorder.recordBeforeProvider(ctx);
    } catch {
      // Recency is helpful metadata and must never block a provider request.
    }
  });
  pi.on("agent_end", () => {
    usageRecorder.cancel();
  });

  pi.registerCommand("profile", {
    description: "Switch work/personal accounts and apply that profile's model/effort default",
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
    if (account.id === "google-vertex") {
      while (true) {
        await saveVertex(runtime);
        const ok = hasVertexAdc() && Boolean(await runtime.getAuth(account.id));
        if (ok) {
          ctx.ui.notify(`${account.label}: using project ${VERTEX_ENV.GOOGLE_CLOUD_PROJECT}.`, "info");
          return;
        }
        const choice = await ctx.ui.select(
          "No gcloud Application Default Credentials. Run `gcloud auth application-default login` as your Sheer Health account, then recheck.",
          ["Recheck gcloud ADC", "Back"],
        );
        if (choice !== "Recheck gcloud ADC") return;
      }
    }
    if (account.id === "openrouter") {
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
    description: "Account login menu: work (Copilot/Vertex AI/Claude) and personal (Codex/OpenRouter)",
    getArgumentCompletions: (prefix) =>
      ACCOUNTS.filter((a) => a.id.startsWith(prefix)).map((a) => ({
        value: a.id,
        label: `${accountScope(a)}: ${a.label}`,
      })),
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
          // Shared accounts log into the active profile; others into their home profile.
          const loginProfile = (account: Account) =>
            providerAllowed(activeProfile, account.id) ? activeProfile : account.profile;
          const choices = ACCOUNTS.map((account) => {
            const saved = readJson(profileAuthPath(agentDir, loginProfile(account)))[account.id];
            const state =
              account.id === "claude-bridge"
                ? "check in Claude Code"
                : saved
                  ? "configured · select to check/reconnect"
                  : "setup needed";
            const scope = accountScope(account);
            return `${scope}${loginProfile(account) === activeProfile ? " *" : ""} · ${account.label} — ${state}`;
          });
          const choice = requested
            ? undefined
            : await ctx.ui.select("Log me in · select an account · Esc closes", choices);
          const account = requested
            ? ACCOUNTS.find((a) => a.id === requested)
            : ACCOUNTS[choices.indexOf(choice ?? "")];
          if (!account) return;
          if (loginProfile(account) === activeProfile) {
            await loginAccount(account, ctx);
            await refreshProfile(ctx, activeProfile);
            await ensurePair(ctx);
            continue;
          }
          if (
            !(await ctx.ui.confirm(
              `Switch to ${account.profile}?`,
              "This changes the available providers and active model. The current conversation is retained; use /new if it should not cross accounts.",
            ))
          )
            continue;
          // Log in while the target profile is bound, before a model is required:
          // the account being connected may be the profile's only login.
          if (!(await switchProfile(ctx, account.profile, (switched) => loginAccount(account, switched)))) return;
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

export const _test = { installStartupProfileBinding };
