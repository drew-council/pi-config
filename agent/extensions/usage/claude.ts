/**
 * Claude Code (Claude Pro/Max subscription) usage parsing.
 *
 * Data source: GET https://api.anthropic.com/api/oauth/usage, authorized with
 * the Claude Code OAuth access token (the login the Claude Code CLI — and the
 * claude-bridge provider — uses). Requires the `oauth-2025-04-20` beta header.
 *
 * Credentials live in ~/.claude/.credentials.json, or on macOS in the login
 * keychain under the "Claude Code-credentials" generic password. When the
 * access token is expired the refresh token is exchanged (same endpoint and
 * client id pi's Anthropic OAuth uses) and the new credentials are written
 * back to the same store, because Anthropic rotates the refresh token.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent } from "./format.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client id (also used by pi's Anthropic OAuth).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-594baad6d249";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ClaudeLimit {
  /** Human label, e.g. "5h session" or "weekly · Fable". */
  label: string;
  usedPercent: number;
  /** ISO timestamp when the window resets. */
  resetsAt: string | null;
  severity: string;
}

export interface ClaudeUsageData {
  /** e.g. "max" (rendered as "Claude Max"). */
  subscription: string | null;
  limits: ClaudeLimit[];
  /** Extra-usage credits note, when the feature is enabled. */
  extraUsageSummary: string | null;
}

type CredentialStore =
  | { kind: "file"; path: string; raw: Record<string, unknown> }
  | { kind: "keychain"; service: string; account: string | null; raw: string };

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  subscription: string | null;
  store: CredentialStore;
}

function execFilePromise(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message;
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

function credentialFrom(raw: Record<string, unknown>, store: CredentialStore): ClaudeCredentials | null {
  const oauth = raw.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return null;
  const entry = oauth as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    subscriptionType?: unknown;
  };
  if (typeof entry.accessToken !== "string" || !entry.accessToken) return null;
  if (typeof entry.refreshToken !== "string" || !entry.refreshToken) return null;
  return {
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : null,
    subscription: typeof entry.subscriptionType === "string" ? entry.subscriptionType : null,
    store,
  };
}

async function readFileCredentials(): Promise<ClaudeCredentials | null> {
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return credentialFrom(raw, { kind: "file", path, raw });
}

/** Read the macOS login keychain entry Claude Code stores its OAuth in. */
async function readKeychainCredentials(): Promise<ClaudeCredentials | null> {
  const json = await execFilePromise("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  const raw = JSON.parse(json) as Record<string, unknown>;
  // Fetch the account attribute so an updated entry lands in the same slot.
  let account: string | null = null;
  try {
    const meta = await execFilePromise("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE]);
    const match = /"acct"<blob>="([^"]*)"/.exec(meta);
    if (match) account = match[1];
  } catch {
    // Attribute lookup is best-effort; -a defaults may still update correctly.
  }
  return credentialFrom(raw, { kind: "keychain", service: KEYCHAIN_SERVICE, account, raw: json });
}

/** Resolve Claude Code credentials, refreshing the OAuth token when expired. */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  let credentials: ClaudeCredentials | null = null;
  try {
    credentials = await readFileCredentials();
  } catch {
    try {
      credentials = await readKeychainCredentials();
    } catch {
      return null;
    }
  }
  if (!credentials) return null;

  const expired = credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
  if (!expired) return credentials;

  const refreshed = await refreshClaudeToken(credentials.refreshToken);
  credentials.accessToken = refreshed.access;
  credentials.refreshToken = refreshed.refresh;
  credentials.expiresAt = refreshed.expires;
  await persistCredentials(credentials);
  return credentials;
}

async function refreshClaudeToken(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`Claude token refresh failed: HTTP ${response.status} from ${new URL(TOKEN_URL).host}`);
  }
  const data = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new Error("Claude token refresh returned an unexpected payload");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Write refreshed credentials back. Anthropic rotates refresh tokens on use,
 * so skipping this would strand the Claude Code CLI with a revoked token.
 */
async function persistCredentials(credentials: ClaudeCredentials): Promise<void> {
  const { store } = credentials;
  if (store.kind === "file") {
    const raw = store.raw as { claudeAiOauth?: Record<string, unknown> };
    raw.claudeAiOauth = {
      ...raw.claudeAiOauth,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
    };
    await writeFile(store.path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const raw = JSON.parse(store.raw) as { claudeAiOauth?: Record<string, unknown> };
  raw.claudeAiOauth = {
    ...raw.claudeAiOauth,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
  };
  const args = ["add-generic-password", "-U", "-s", store.service];
  if (store.account !== null) args.push("-a", store.account);
  args.push("-w", JSON.stringify(raw));
  await execFilePromise("security", args);
}

function limitLabel(kind: string, scopedModel: string | null): string {
  switch (kind) {
    case "session":
      return "5h session";
    case "weekly_all":
      return "weekly · all models";
    case "weekly_scoped":
      return `weekly · ${scopedModel ?? "scoped models"}`;
    default:
      return scopedModel ? `${kind.replace(/_/g, " ")} · ${scopedModel}` : kind.replace(/_/g, " ");
  }
}

function limitFromWindow(label: string, raw: unknown): ClaudeLimit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const window = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization = Number(window.utilization);
  if (!Number.isFinite(utilization)) return null;
  return {
    label,
    usedPercent: clampPercent(utilization),
    resetsAt: typeof window.resets_at === "string" ? window.resets_at : null,
    severity: "normal",
  };
}

/** Parse the JSON body of GET https://api.anthropic.com/api/oauth/usage. */
export function parseClaudeUsage(payload: unknown, subscription: string | null): ClaudeUsageData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as {
    limits?: unknown;
    five_hour?: unknown;
    seven_day?: unknown;
    seven_day_opus?: unknown;
    seven_day_sonnet?: unknown;
    seven_day_oauth_apps?: unknown;
    extra_usage?: unknown;
  };

  const limits: ClaudeLimit[] = [];

  // Preferred: the structured limits array (includes model-scoped weekly bars).
  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as {
        kind?: unknown;
        percent?: unknown;
        resets_at?: unknown;
        severity?: unknown;
        scope?: { model?: { display_name?: unknown } | null } | null;
      };
      const percent = Number(item.percent);
      if (!Number.isFinite(percent)) continue;
      const kind = typeof item.kind === "string" ? item.kind : "unknown";
      const scopedModel = typeof item.scope?.model?.display_name === "string" ? item.scope.model.display_name : null;
      limits.push({
        label: limitLabel(kind, scopedModel),
        usedPercent: clampPercent(percent),
        resetsAt: typeof item.resets_at === "string" ? item.resets_at : null,
        severity: typeof item.severity === "string" ? item.severity : "normal",
      });
    }
  }

  // Fallback: the flat five_hour/seven_day windows.
  if (limits.length === 0) {
    const fallbacks: Array<[string, unknown]> = [
      ["5h session", data.five_hour],
      ["weekly · all models", data.seven_day],
      ["weekly · Opus", data.seven_day_opus],
      ["weekly · Sonnet", data.seven_day_sonnet],
      ["weekly · apps", data.seven_day_oauth_apps],
    ];
    for (const [label, raw] of fallbacks) {
      const limit = limitFromWindow(label, raw);
      if (limit) limits.push(limit);
    }
  }

  if (limits.length === 0) return null;

  let extraUsageSummary: string | null = null;
  if (typeof data.extra_usage === "object" && data.extra_usage !== null) {
    const extra = data.extra_usage as {
      is_enabled?: unknown;
      monthly_limit?: unknown;
      used_credits?: unknown;
    };
    if (extra.is_enabled === true) {
      const used = Number(extra.used_credits);
      const limit = Number(extra.monthly_limit);
      const usedText = Number.isFinite(used) ? `$${(used / 100).toFixed(2)}` : "?";
      const limitText = Number.isFinite(limit) ? `$${(limit / 100).toFixed(2)}` : "no cap";
      extraUsageSummary = `extra usage: ${usedText} of ${limitText}`;
    }
  }

  return {
    subscription,
    limits,
    extraUsageSummary,
  };
}
