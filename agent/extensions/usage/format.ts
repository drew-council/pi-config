/** Shared formatting helpers for the /usage extension. */

export function humanizeSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "now";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function clampPercent(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Format an ISO reset timestamp: local clock time within 24h, otherwise the date. */
export function formatResetTime(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  if (time - Date.now() < 24 * 3600 * 1000) {
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}
