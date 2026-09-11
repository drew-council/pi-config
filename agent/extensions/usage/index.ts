import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, matchesKey, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PROFILE_NAMES, type ProfileName, profileAuthPath, providerAllowed } from "../shared/accounts.js";
import { type ClaudeUsageData, parseClaudeUsage, readClaudeCredentials } from "./claude.js";
import { type CodexUsageData, parseCodexUsage } from "./codex.js";
import { clampPercent, formatMoney, formatResetTime, humanizeSeconds } from "./format.js";
import { type CopilotUsageData, parseCopilotUsage } from "./github-copilot.js";
import { applyOpenRouterCredits, type OpenRouterUsageData, parseOpenRouterKeyUsage } from "./openrouter.js";
import { usageColumns } from "./view.js";

const AGENT_DIR = getAgentDir();

const SECRETS_FILE = join(homedir(), ".pi", "secrets", "personal.json");

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const BAR_WIDTH = 24;

type ProviderResult<T> = { status: "ok"; data: T } | { status: "error"; message: string };

export interface Snapshot {
  codex: ProviderResult<CodexUsageData> | null;
  claude: ProviderResult<ClaudeUsageData> | null;
  copilot: ProviderResult<CopilotUsageData> | null;
  openrouter: ProviderResult<OpenRouterUsageData> | null;
  fetchedAt: number;
}

interface CodexCredentials {
  access: string;
  accountId: string | null;
  expiresAt: number | null;
  /** Where the credential was resolved from, for error messages. */
  source: string;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function codexCredentialsFrom(auth: unknown, source: string): CodexCredentials | null {
  const providers = auth as Record<string, Record<string, unknown>> | null;
  const codex = providers?.["openai-codex"];
  if (!codex || typeof codex.access !== "string" || !codex.access) return null;
  return {
    access: codex.access,
    accountId: typeof codex.accountId === "string" ? codex.accountId : null,
    expiresAt: typeof codex.expires === "number" ? codex.expires : null,
    source,
  };
}

// Usage reads each provider's owning profile, never the active/global store.
async function readCodexCredentials(agentDir = AGENT_DIR): Promise<CodexCredentials | null> {
  return codexCredentialsFrom(await readJson(profileAuthPath(agentDir, "personal")), 'auth profile "personal"');
}

async function readOpenRouterApiKey(): Promise<string | null> {
  const auth = (await readJson(profileAuthPath(AGENT_DIR, "personal"))) as {
    openrouter?: { type?: string; key?: unknown };
  } | null;
  if (auth?.openrouter?.type === "api_key" && typeof auth.openrouter.key === "string" && auth.openrouter.key.trim())
    return auth.openrouter.key.trim();
  const secrets = (await readJson(SECRETS_FILE)) as { openrouter?: { apiKey?: unknown } } | null;
  const key = secrets?.openrouter?.apiKey;
  if (typeof key === "string" && key.trim()) return key.trim();
  return null;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  return (await response.json()) as unknown;
}

async function fetchCodex(signal: AbortSignal | undefined): Promise<ProviderResult<CodexUsageData>> {
  const credentials = await readCodexCredentials();
  if (!credentials) {
    return { status: "error", message: "not logged in (run /login for openai-codex)" };
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
    return {
      status: "error",
      message: `access token expired in ${credentials.source} (run /login to refresh)`,
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.access}`,
    Accept: "application/json",
    "User-Agent": "codex_cli_rs",
    originator: "codex_cli_rs",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  try {
    const payload = await fetchJson(CODEX_USAGE_URL, headers, signal);
    const data = parseCodexUsage(payload);
    if (!data) return { status: "error", message: "unexpected response payload" };
    return { status: "ok", data };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchOpenRouter(signal: AbortSignal | undefined): Promise<ProviderResult<OpenRouterUsageData>> {
  const apiKey = await readOpenRouterApiKey();
  if (!apiKey) {
    return { status: "error", message: `no API key found (openrouter.apiKey in ${SECRETS_FILE})` };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  try {
    const keyPayload = await fetchJson(OPENROUTER_KEY_URL, headers, signal);
    const data = parseOpenRouterKeyUsage(keyPayload);
    if (!data) return { status: "error", message: "unexpected response payload" };
    try {
      const creditsPayload = await fetchJson(OPENROUTER_CREDITS_URL, headers, signal);
      return { status: "ok", data: applyOpenRouterCredits(data, creditsPayload) };
    } catch {
      return { status: "ok", data };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

interface CopilotCredentials {
  /** GitHub OAuth token; authorizes copilot_internal/user. */
  refreshToken: string;
  /** Where the credential was resolved from, for error messages. */
  source: string;
}

function copilotCredentialFrom(auth: unknown, source: string): CopilotCredentials | null {
  const providers = auth as Record<string, Record<string, unknown>> | null;
  const copilot = providers?.["github-copilot"];
  if (!copilot || copilot.type !== "oauth" || typeof copilot.refresh !== "string" || !copilot.refresh) {
    return null;
  }
  return { refreshToken: copilot.refresh, source };
}

async function readCopilotCredentials(agentDir = AGENT_DIR): Promise<CopilotCredentials | null> {
  return copilotCredentialFrom(await readJson(profileAuthPath(agentDir, "work")), 'auth profile "work"');
}

async function fetchCopilot(signal: AbortSignal | undefined): Promise<ProviderResult<CopilotUsageData>> {
  const credentials = await readCopilotCredentials();
  if (!credentials) {
    return { status: "error", message: "not logged in (run /login for GitHub Copilot)" };
  }
  // Match the Copilot client headers pi itself sends; GitHub rejects some
  // requests without them.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.refreshToken}`,
    Accept: "application/json",
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
  };
  try {
    const payload = await fetchJson(COPILOT_USER_URL, headers, signal);
    const data = parseCopilotUsage(payload);
    if (!data) return { status: "error", message: "unexpected response payload" };
    return { status: "ok", data };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetch Claude Code (Pro/Max) usage via the Claude Code OAuth credentials. */
async function fetchClaude(signal: AbortSignal | undefined): Promise<ProviderResult<ClaudeUsageData>> {
  try {
    const credentials = await readClaudeCredentials();
    if (!credentials) {
      return {
        status: "error",
        message: "no Claude Code login found (keychain or ~/.claude/.credentials.json)",
      };
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    };
    const payload = await fetchJson(CLAUDE_USAGE_URL, headers, signal);
    const data = parseClaudeUsage(payload, credentials.subscription);
    if (!data) return { status: "error", message: "unexpected response payload" };
    return { status: "ok", data };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function loadSnapshot(signal: AbortSignal | undefined): Promise<Snapshot> {
  const [codex, claude, copilot, openrouter] = await Promise.all([
    fetchCodex(signal),
    fetchClaude(signal),
    fetchCopilot(signal),
    fetchOpenRouter(signal),
  ]);
  return { codex, claude, copilot, openrouter, fetchedAt: Date.now() };
}

function remainingColor(remainingPercent: number): string {
  return remainingPercent <= 10 ? "error" : remainingPercent <= 30 ? "warning" : "success";
}

function percentColor(
  theme: { fg: (color: string, text: string) => string },
  remainingPercent: number,
  text: string,
): string {
  return theme.fg(remainingColor(remainingPercent), text);
}

/** Bar filled by the remaining share of the limit. */
function renderBar(theme: { fg: (color: string, text: string) => string }, remainingPercent: number): string {
  const filled = Math.round((clampPercent(remainingPercent) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return theme.fg(remainingColor(remainingPercent), "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

function percentLeftText(remainingPercent: number): string {
  const remaining = clampPercent(remainingPercent);
  const label = remaining >= 9.95 ? `${Math.round(remaining)}% left` : `${remaining.toFixed(2)}% left`;
  return label;
}

function snapshotLines(
  snapshot: Snapshot,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): string[] {
  const lines: string[] = [];
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);

  const codex = snapshot.codex;
  if (codex) {
    lines.push(theme.bold("OpenAI Codex"));
    if (codex.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", codex.message)}`);
    } else {
      const data = codex.data;
      const windows = data.windows.length ? data.windows : [{ label: "?", usedPercent: 0, resetAfterSeconds: null }];
      for (const win of windows) {
        const remaining = 100 - clampPercent(win.usedPercent);
        const reset =
          win.resetAfterSeconds !== null ? dim(`  resets in ${humanizeSeconds(win.resetAfterSeconds)}`) : "";
        lines.push(
          `  ${muted(win.label.padEnd(3))} window  ${renderBar(theme, remaining)}  ${percentColor(theme, remaining, percentLeftText(remaining))}${reset}`,
        );
      }
      if (data.rateLimitReached) lines.push(`  ${theme.fg("error", "rate limit reached")}`);
      if (data.creditsSummary) lines.push(`  ${dim("credits:")} ${data.creditsSummary}`);
      const spend = data.spendControl;
      if (spend) {
        const remaining = 100 - clampPercent(spend.usedPercent);
        const limitText = spend.limit !== null ? formatMoney(spend.limit) : "unknown limit";
        const reset = spend.resetAfterSeconds !== null ? `, resets in ${humanizeSeconds(spend.resetAfterSeconds)}` : "";
        lines.push(
          `  ${dim("spend control:")} ${percentColor(theme, remaining, percentLeftText(remaining))} of ${limitText}${reset} ${dim(`(${spend.source})`)}`,
        );
      }
    }
    lines.push("");
  }

  const claude = snapshot.claude;
  if (claude) {
    lines.push(theme.bold("Claude Code"));
    if (claude.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", claude.message)}`);
    } else {
      const data = claude.data;
      const plan = data.subscription
        ? `Claude ${data.subscription.charAt(0).toUpperCase()}${data.subscription.slice(1)}`
        : "Claude Code";
      lines.push(`  ${dim(plan)}`);
      for (const limit of data.limits) {
        const remaining = 100 - clampPercent(limit.usedPercent);
        const reset = limit.resetsAt ? dim(`  resets ${formatResetTime(limit.resetsAt)}`) : "";
        const color = limit.severity !== "normal" ? "error" : remainingColor(remaining);
        lines.push(
          `  ${muted(limit.label.padEnd(20))}  ${renderBar(theme, remaining)}  ${theme.fg(color, percentLeftText(remaining))}${reset}`,
        );
      }
      if (data.extraUsageSummary) lines.push(`  ${dim(data.extraUsageSummary)}`);
    }
    lines.push("");
  }

  const copilot = snapshot.copilot;
  if (copilot) {
    lines.push(theme.bold("GitHub Copilot"));
    if (copilot.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", copilot.message)}`);
    } else {
      const data = copilot.data;
      const plan = data.plan ? `Copilot ${data.plan.charAt(0).toUpperCase()}${data.plan.slice(1)}` : "Copilot";
      const reset = data.resetDate ? dim(`  resets ${data.resetDate}`) : "";
      lines.push(`  ${dim(plan)}${reset}`);
      for (const quota of data.quotas) {
        const label = muted(quota.label.padEnd(20));
        if (quota.unlimited) {
          lines.push(`  ${label}  ${dim("unlimited")}`);
          continue;
        }
        const remaining = quota.remainingPercent ?? 100;
        const overage = quota.overageCount > 0 ? dim(`  +${quota.overageCount.toLocaleString()} overage`) : "";
        lines.push(
          `  ${label}  ${renderBar(theme, remaining)}  ${percentColor(theme, remaining, percentLeftText(remaining))}${overage}`,
        );
        if (quota.creditsUsed !== null && quota.entitlement !== null) {
          const used = quota.creditsUsed.toLocaleString();
          const total = quota.entitlement.toLocaleString();
          // 1 AI credit = $0.01
          const spent = formatMoney(quota.creditsUsed / 100);
          const pool = formatMoney(quota.entitlement / 100);
          lines.push(`  ${" ".repeat(20)}  ${dim(`${used} of ${total} credits used (${spent} of ${pool})`)}`);
        } else if (quota.creditsUsed !== null) {
          lines.push(`  ${" ".repeat(20)}  ${dim(`${quota.creditsUsed.toLocaleString()} credits used`)}`);
        }
      }
    }
    lines.push("");
  }

  const openrouter = snapshot.openrouter;
  if (openrouter) {
    lines.push(theme.bold("OpenRouter"));
    if (openrouter.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", openrouter.message)}`);
    } else {
      const data = openrouter.data;
      if (data.limit !== null) {
        const remaining = data.limit > 0 ? clampPercent(((data.limit - data.usage) / data.limit) * 100) : 100;
        const remainingMoney =
          data.limitRemaining !== null ? formatMoney(data.limitRemaining) : formatMoney(data.limit - data.usage);
        const reset = data.limitReset ? dim(` (${data.limitReset})`) : "";
        lines.push(`  ${renderBar(theme, remaining)}  ${percentColor(theme, remaining, percentLeftText(remaining))}`);
        lines.push(
          `  ${remainingMoney} left of ${formatMoney(data.limit)}${reset} ${dim(`(${formatMoney(data.usage)} used)`)}`,
        );
      } else {
        lines.push(`  ${formatMoney(data.usage)} used (no key limit)`);
      }
      if (data.totalCredits !== null) {
        const left = Math.max(0, data.totalCredits - (data.totalUsage ?? data.usage));
        lines.push(`  ${dim("credits:")} ${formatMoney(left)} of ${formatMoney(data.totalCredits)} remaining`);
      }
    }
  }

  if (!codex && !claude && !copilot && !openrouter) {
    lines.push(dim("No provider credentials found."));
  }
  return lines;
}

export function profileSnapshotLines(
  snapshot: Snapshot,
  theme: Parameters<typeof snapshotLines>[1],
  profile: ProfileName,
): string[] {
  const scoped = {
    ...snapshot,
    codex: providerAllowed(profile, "openai-codex") ? snapshot.codex : null,
    claude: providerAllowed(profile, "claude-bridge") ? snapshot.claude : null,
    copilot: providerAllowed(profile, "github-copilot") ? snapshot.copilot : null,
    openrouter: providerAllowed(profile, "openrouter") ? snapshot.openrouter : null,
  };
  const lines = [theme.bold(profile === "work" ? "Work" : "Personal"), "", ...snapshotLines(scoped, theme)];
  if (providerAllowed(profile, "google"))
    lines.push("", theme.bold("Google Gemini"), theme.fg("dim", "  Usage reporting not supported."));
  return lines;
}

export function profileColumns(
  snapshot: Snapshot,
  theme: Parameters<typeof snapshotLines>[1],
  width: number,
): string[] {
  return usageColumns(snapshot, theme).render(width);
}

function plainSnapshotText(snapshot: Snapshot): string {
  const lines = PROFILE_NAMES.flatMap((profile) =>
    profileSnapshotLines(
      snapshot,
      {
        fg: (_color, text) => text,
        bold: (text) => text,
      },
      profile,
    ),
  );
  return lines.join("\n").replace(/█|░/g, (c) => (c === "█" ? "#" : "-"));
}

export const _test = { readCodexCredentials, readCopilotCredentials };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show usage in Work and Personal profile columns",
    handler: async (_args, ctx) => {
      let snapshot: Snapshot | null = null;

      if (ctx.mode !== "tui") {
        snapshot = await loadSnapshot(undefined);
        ctx.ui.notify(plainSnapshotText(snapshot), "info");
        return;
      }

      snapshot = await ctx.ui.custom<Snapshot | null>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Fetching provider usage...");
        loader.onAbort = () => done(null);
        loadSnapshot(loader.signal)
          .then(done)
          .catch(() => done(null));
        return loader;
      });

      if (!snapshot) return;

      let refreshing = false;
      await ctx.ui.custom((_tui, theme, _keybindings, done) => {
        let cached: { width: number; lines: string[] } | undefined;

        const refresh = async () => {
          if (refreshing) return;
          refreshing = true;
          cached = undefined;
          _tui.requestRender();
          try {
            snapshot = await loadSnapshot(undefined);
          } catch {
            // keep previous snapshot on refresh failure
          }
          refreshing = false;
          cached = undefined;
          _tui.requestRender();
        };

        return {
          render(width: number): string[] {
            if (cached && cached.width === width) return cached.lines;
            const current = snapshot;
            if (!current) return [truncateToWidth("Usage unavailable", width)];

            const panel = new Container();
            panel.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
            const body = new Box(2, 1);
            const stamp = new Date(current.fetchedAt).toLocaleTimeString();
            body.addChild(
              new Text(
                theme.bold("Provider usage") +
                  theme.fg("dim", `  Updated ${stamp}`) +
                  (refreshing ? theme.fg("accent", "  Refreshing…") : ""),
                0,
                0,
              ),
            );
            body.addChild(new Spacer(1));
            body.addChild(usageColumns(current, theme));
            body.addChild(new Spacer(1));
            body.addChild(new Text(theme.fg("dim", "r  Refresh   esc  Close"), 0, 0));
            panel.addChild(body);
            panel.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
            cached = { width, lines: panel.render(width) };
            return cached.lines;
          },
          invalidate() {
            cached = undefined;
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || data === "q") {
              done(undefined);
              return;
            }
            if (data === "r" || data === "R") {
              void refresh();
            }
          },
        };
      });
    },
  });
}
