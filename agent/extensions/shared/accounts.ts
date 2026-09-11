import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api, Credential, Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PROFILE_NAMES = ["work", "personal"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export const ACCOUNTS = [
  { id: "github-copilot", profile: "work", label: "GitHub Copilot · drew-council" },
  { id: "google", profile: "work", label: "Google Gemini · Sheer Health API key" },
  { id: "claude-bridge", profile: "work", label: "Claude Code · external login" },
  { id: "openai-codex", profile: "personal", label: "OpenAI Codex · subscription" },
  { id: "openrouter", profile: "personal", label: "OpenRouter · API key" },
] as const;
export type Account = (typeof ACCOUNTS)[number];
export const providersFor = (profile: ProfileName): string[] =>
  ACCOUNTS.filter((account) => account.profile === profile).map((account) => account.id);
export const providerAllowed = (profile: ProfileName, provider: string): boolean =>
  providersFor(profile).includes(provider);
export const isProfileName = (value: unknown): value is ProfileName => value === "work" || value === "personal";
export const profileAuthPath = (agentDir: string, profile: ProfileName) =>
  join(agentDir, "auth-profiles", `${profile}.json`);

export function readJson(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
  }
  // Never echo JSON parser errors: they can contain credential text.
  throw new Error(`Cannot read JSON object from ${path}`);
}

// Match whole directory components, including the root itself, not ~/workshop.
// Linked worktrees (e.g. ~/.herdr/worktrees/<repo>/<branch>) have a .git file
// instead of a directory, so they resolve to the profile of their main
// repository's directory rather than falling back to the saved default.
export function profileForDirectory(cwd: string, home = homedir()): ProfileName | undefined {
  const root = relative(home, cwd).split(sep)[0];
  if (isProfileName(root)) return root;
  const main = mainRepositoryRoot(cwd);
  return main ? profileForDirectory(main, home) : undefined;
}

function mainRepositoryRoot(cwd: string): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    const gitPath = join(directory, ".git");
    try {
      if (statSync(gitPath).isFile()) {
        const gitdir = /^gitdir:\s*(\S.*\S|\S)\s*$/m.exec(readFileSync(gitPath, "utf8"))?.[1];
        if (!gitdir) return undefined;
        const absolute = isAbsolute(gitdir) ? gitdir : resolve(directory, gitdir);
        // Worktrees (<main>/.git/worktrees/<name>) and submodules
        // (<main>/.git/modules/<path>) both resolve to the root before .git.
        const segments = absolute.split(sep);
        const dotGit = segments.lastIndexOf(".git");
        return dotGit > 0 ? segments.slice(0, dotGit).join(sep) : undefined;
      }
    } catch {
      // No .git here; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function readActiveProfile(agentDir: string): ProfileName {
  const inherited = process.env.PI_AUTH_PROFILE;
  if (isProfileName(inherited)) return inherited;
  const value = readJson(join(agentDir, "auth-profiles.json")).activeProfile;
  return isProfileName(value) ? value : "work";
}

export function writeActiveProfile(agentDir: string, profile: ProfileName): void {
  const path = join(agentDir, "auth-profiles.json");
  writeFileSync(path, `${JSON.stringify({ ...readJson(path), activeProfile: profile }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function ensureProfileFiles(agentDir: string): void {
  const directory = join(agentDir, "auth-profiles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  try {
    writeFileSync(join(agentDir, "auth-profiles.json"), '{"activeProfile":"work"}\n', { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const profile of PROFILE_NAMES) {
    const path = profileAuthPath(agentDir, profile);
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only import credentials into their designated profile; leave the source untouched.
      const legacy = readJson(join(agentDir, "auth.json"));
      const entries = Object.fromEntries(Object.entries(legacy).filter(([id]) => providerAllowed(profile, id)));
      writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
  }
}

export function readAccountKey(agentDir: string, provider: "google" | "openrouter"): string {
  const profile = provider === "google" ? "work" : "personal";
  const path = join(agentDir, "..", "secrets", `${profile}.json`);
  const data = readJson(path);
  const entry = data[provider === "google" ? "gemini" : "openrouter"] as { apiKey?: unknown } | undefined;
  if (typeof entry?.apiKey !== "string" || !entry.apiKey.trim() || entry.apiKey.includes("op://")) {
    throw new Error(
      `Missing ${profile} ${provider} key. Run ~/.pi/scripts/install.nu to initialize 1Password secrets.`,
    );
  }
  return entry.apiKey.trim();
}

export async function importAccountKey(
  runtime: ModelRuntime,
  agentDir: string,
  provider: "google" | "openrouter",
): Promise<void> {
  const key = readAccountKey(agentDir, provider);
  await runtime.login(provider, "api_key", {
    signal: AbortSignal.timeout(5_000),
    prompt: async () => key,
    notify: () => {},
  });
}

export type Exec = Pick<ExtensionAPI, "exec">["exec"];

// Do not use gh's active account or ambient GH_TOKEN: request this exact stored login,
// then verify the returned token's identity before exchanging it with Copilot.
export async function copilotFromGh(exec: Exec, provider: Provider, signal: AbortSignal): Promise<OAuthCredential> {
  const result = await exec("gh", ["auth", "token", "--hostname", "github.com", "--user", "drew-council"], {
    signal,
    timeout: 10_000,
  });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error("Sign into drew-council with gh auth login first.");
  const token = result.stdout.trim();
  await verifyGitHubAccount(token, signal);
  if (!provider.auth.oauth) throw new Error("Copilot OAuth is unavailable in this Pi version.");
  try {
    // Native refresh exchanges the GitHub token and discovers this account's enabled models.
    // Unlike native browser login, it does not enable additional model policies.
    return await provider.auth.oauth.refresh({ type: "oauth", refresh: token, access: "", expires: 0 }, signal);
  } catch {
    throw new Error("The gh token could not access Copilot. Use browser login for drew-council instead.");
  }
}

export async function verifyGitHubAccount(token: string, signal: AbortSignal): Promise<void> {
  const response = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) throw new Error("Could not verify the gh account. Reauthenticate gh, or use browser login.");
  const user = (await response.json()) as { login?: string };
  if (user.login?.toLowerCase() !== "drew-council")
    throw new Error("gh returned a different account; expected drew-council.");
}

export async function saveCopilot(
  runtime: ModelRuntime,
  credential: OAuthCredential,
  signal = AbortSignal.timeout(5_000),
): Promise<void> {
  // Use the normal credential store's locked mutation without replacing provider auth.
  const store = runtimeStore(runtime);
  await store.modify(
    "github-copilot",
    async () => {
      signal.throwIfAborted();
      return credential;
    },
    { signal },
  );
  await runtime.refresh({ providers: ["github-copilot"], allowNetwork: false, signal });
}

type FileStore = {
  readonly authPath?: string;
  read(provider: string): Promise<Credential | undefined>;
  modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined>;
  constructor: { create(path: string): FileStore };
};
type RuntimeInternals = { credentials: { store: FileStore; overrides: Map<string, string> } };
export function runtimeStore(runtime: ModelRuntime): FileStore {
  const store = (runtime as unknown as RuntimeInternals).credentials?.store;
  if (typeof store?.constructor.create !== "function" || typeof store.modify !== "function") {
    throw new Error("Pi's credential-store API changed; update the auth-profiles adapter before logging in.");
  }
  return store;
}
const DEFAULT_AUTH_FILE = "auth.json";

/**
 * Binds the active profile's credential store, but only when the runtime still
 * points at the untouched default auth.json. Runs during extension loading so
 * pi's post-extension-load availability refresh (which computes the startup
 * model list before any session_start handler) sees profile credentials;
 * explicit binds from session_start, /profile and /log-me-in always win.
 */
export function bindStartupProfile(runtime: ModelRuntime, agentDir: string): boolean {
  const store = runtimeStore(runtime);
  if (store.authPath !== join(agentDir, DEFAULT_AUTH_FILE)) return false;
  ensureProfileFiles(agentDir);
  bindRuntimeProfile(runtime, agentDir, readActiveProfile(agentDir));
  return true;
}

export function bindRuntimeProfile(runtime: ModelRuntime, agentDir: string, profile: ProfileName): void {
  const store = runtimeStore(runtime);
  const credentials = (runtime as unknown as RuntimeInternals).credentials;
  if (!(credentials.overrides instanceof Map)) throw new Error("Pi's runtime credential API changed.");
  // New fixed-path backend: an in-flight refresh on the old store cannot write into the new profile.
  credentials.store = store.constructor.create(profileAuthPath(agentDir, profile));
  credentials.overrides.clear();
}

export function chooseProfileModel(
  models: readonly Model<Api>[],
  profile: ProfileName,
  previous?: Model<Api>,
): Model<Api> | undefined {
  const allowed = models.filter((model) => providerAllowed(profile, model.provider));
  return (
    allowed.find((model) => model.provider === previous?.provider && model.id === previous.id) ??
    providersFor(profile).flatMap((provider) => allowed.filter((model) => model.provider === provider))[0]
  );
}

export async function claudeStatus(exec: Exec): Promise<{ loggedIn: boolean; detail: string }> {
  try {
    const result = await exec("claude", ["auth", "status"], { timeout: 5_000 });
    const status = JSON.parse(result.stdout) as { loggedIn?: boolean; email?: string; orgName?: string };
    if (result.code === 0 && status.loggedIn === true) {
      return { loggedIn: true, detail: [status.email, status.orgName].filter(Boolean).join(" · ") || "logged in" };
    }
  } catch {
    /* Missing executable or older Claude CLI. Never display raw output. */
  }
  return { loggedIn: false, detail: "Open Claude Code and run /login yourself, then recheck here." };
}
