/**
 * GitHub Copilot usage parsing.
 *
 * Data source: GET https://api.github.com/copilot_internal/user, authorized
 * with the GitHub OAuth token stored in the Copilot credential's `refresh`
 * field (the Copilot proxy token in `access` is not accepted there).
 *
 * Under Copilot's usage-based billing, model interactions consume GitHub AI
 * credits (1 credit = $0.01 USD) at per-token model rates. Code completions
 * remain unlimited and are not billed in credits. Business/Enterprise credits
 * are pooled per billing entity and reset on the first of each month.
 */

export interface CopilotQuota {
  /** Human label, e.g. "premium interactions". */
  label: string;
  unlimited: boolean;
  /** Included monthly allowance in AI credits, null when unlimited. */
  entitlement: number | null;
  /** AI credits consumed in the current cycle. */
  creditsUsed: number | null;
  remainingPercent: number | null;
  overagePermitted: boolean;
  overageCount: number;
}

export interface CopilotUsageData {
  /** e.g. "business" (rendered as "Copilot Business"). */
  plan: string | null;
  /** ISO date the credit allowance resets, e.g. "2026-10-01". */
  resetDate: string | null;
  quotas: CopilotQuota[];
}

const QUOTA_LABELS: Record<string, string> = {
  chat: "chat",
  completions: "completions",
  premium_interactions: "premium interactions",
};

const QUOTA_ORDER = Object.keys(QUOTA_LABELS);

function parseQuota(id: string, raw: unknown): CopilotQuota | null {
  if (typeof raw !== "object" || raw === null) return null;
  const quota = raw as {
    unlimited?: unknown;
    entitlement?: unknown;
    credits_used?: unknown;
    percent_remaining?: unknown;
    overage_permitted?: unknown;
    overage_count?: unknown;
    has_quota?: unknown;
  };
  if (quota.has_quota === false) return null;
  const unlimited = quota.unlimited === true;
  const entitlement = Number(quota.entitlement);
  const creditsUsed = Number(quota.credits_used);
  const percentRemaining = Number(quota.percent_remaining);
  const overageCount = Number(quota.overage_count);
  if (!unlimited && !Number.isFinite(entitlement) && !Number.isFinite(percentRemaining)) return null;
  return {
    label: QUOTA_LABELS[id] ?? id,
    unlimited,
    entitlement: unlimited || !Number.isFinite(entitlement) ? null : entitlement,
    creditsUsed: Number.isFinite(creditsUsed) ? creditsUsed : null,
    remainingPercent: unlimited || !Number.isFinite(percentRemaining) ? null : percentRemaining,
    overagePermitted: quota.overage_permitted === true,
    overageCount: Number.isFinite(overageCount) ? overageCount : 0,
  };
}

/** Parse the JSON body of GET https://api.github.com/copilot_internal/user. */
export function parseCopilotUsage(payload: unknown): CopilotUsageData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as {
    copilot_plan?: unknown;
    quota_reset_date?: unknown;
    quota_snapshots?: Record<string, unknown>;
  };
  const snapshots =
    typeof data.quota_snapshots === "object" && data.quota_snapshots !== null ? data.quota_snapshots : null;
  if (!snapshots) return null;
  const quotas: CopilotQuota[] = [];
  for (const [id, raw] of Object.entries(snapshots)) {
    const quota = parseQuota(id, raw);
    if (quota) quotas.push(quota);
  }
  quotas.sort((a, b) => {
    const ai = QUOTA_ORDER.indexOf(a.label === "premium interactions" ? "premium_interactions" : a.label);
    const bi = QUOTA_ORDER.indexOf(b.label === "premium interactions" ? "premium_interactions" : b.label);
    return (ai === -1 ? QUOTA_ORDER.length : ai) - (bi === -1 ? QUOTA_ORDER.length : bi);
  });
  if (quotas.length === 0) return null;
  return {
    plan: typeof data.copilot_plan === "string" ? data.copilot_plan : null,
    resetDate: typeof data.quota_reset_date === "string" ? data.quota_reset_date : null,
    quotas,
  };
}
