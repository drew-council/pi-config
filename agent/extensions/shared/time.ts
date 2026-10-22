/** Format a millisecond duration as space-separated `h m s` units (`45s`, `42m 13s`, `1h 14m 17s`). */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format a `Date` or epoch millisecond timestamp as a 12-hour local clock time (`11:14 AM`). */
export function formatClockTime(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\s+/g, " ");
}
