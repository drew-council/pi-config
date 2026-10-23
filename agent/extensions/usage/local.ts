import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalUsageEvent {
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface LocalUsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface LocalUsageSummary {
  last5h: LocalUsageTotals;
  last7d: LocalUsageTotals;
}

const emptyTotals = (): LocalUsageTotals => ({
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

export const emptyLocalUsage = (): LocalUsageSummary => ({ last5h: emptyTotals(), last7d: emptyTotals() });

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseEvent(value: unknown): LocalUsageEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    !isFiniteNumber(event.at) ||
    !isFiniteNumber(event.input) ||
    !isFiniteNumber(event.output) ||
    !isFiniteNumber(event.cacheRead) ||
    !isFiniteNumber(event.cacheWrite) ||
    !isFiniteNumber(event.totalTokens) ||
    !isFiniteNumber(event.cost)
  )
    return null;
  return {
    at: event.at,
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    totalTokens: event.totalTokens,
    cost: event.cost,
  };
}

/** Local Pi activity only: this is not ChatGPT plan quota. */
export const localUsagePath = (agentDir: string): string => join(agentDir, "chatgpt-local-usage.jsonl");

export function appendLocalUsage(agentDir: string, usage: Usage, at = Date.now()): void {
  if (!Number.isFinite(at) || !Number.isFinite(usage.totalTokens)) return;
  const event: LocalUsageEvent = {
    at,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
  appendFileSync(localUsagePath(agentDir), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readLocalUsage(agentDir: string, now = Date.now()): LocalUsageSummary {
  let contents: string;
  try {
    contents = readFileSync(localUsagePath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyLocalUsage();
  }
  const summary = emptyLocalUsage();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = parseEvent(parsed);
    if (!event || event.at > now) continue;
    const add = (totals: LocalUsageTotals) => {
      totals.requests++;
      totals.input += event.input;
      totals.output += event.output;
      totals.cacheRead += event.cacheRead;
      totals.cacheWrite += event.cacheWrite;
      totals.totalTokens += event.totalTokens;
      totals.cost += event.cost;
    };
    if (now - event.at <= SEVEN_DAYS_MS) add(summary.last7d);
    if (now - event.at <= FIVE_HOURS_MS) add(summary.last5h);
  }
  return summary;
}

export const _test = { parseEvent };
