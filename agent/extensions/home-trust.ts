/**
 * Lets `trust.json` keys use `~/` so one entry covers macOS and Linux homes.
 *
 * Pi matches trust keys literally, so this extension owns the `project_trust` decision whenever a saved entry
 * applies. On session start it rewrites absolute keys under the current home, such as those `/trust` saves, to `~/`.
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type ExtensionAPI, getAgentDir, type ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

type TrustData = Record<string, boolean | null>;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readTrust(path: string): TrustData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const data: TrustData = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true || value === false || value === null) data[key] = value;
  }
  return data;
}

function expandKey(key: string, home: string): string {
  if (key === "~") return home;
  return key.startsWith("~/") ? join(home, key.slice(2)) : key;
}

function contractKey(key: string, home: string): string {
  if (key === home) return "~";
  return key.startsWith(home + sep) ? `~/${key.slice(home.length + 1)}` : key;
}

/** Returns the nearest saved decision for `cwd`, checking `cwd` and then each parent. */
export function findDecision(data: TrustData, cwd: string, home: string): boolean | null {
  const expanded = new Map<string, boolean>();
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "boolean") expanded.set(expandKey(key, home), value);
  }
  let current = canonical(cwd);
  while (true) {
    const decision = expanded.get(current);
    if (decision !== undefined) return decision;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Rewrites keys under `home` to `~/` form and sorts them. On a conflict the absolute key wins because Pi wrote it
 * most recently.
 */
export function normalizeTrust(data: TrustData, home: string): TrustData {
  const merged: TrustData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("~")) merged[key] = value;
  }
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("~")) merged[contractKey(key, home)] = value;
  }
  const sorted: TrustData = {};
  for (const key of Object.keys(merged).sort()) {
    if (merged[key] !== null) sorted[key] = merged[key];
  }
  return sorted;
}

function trustPath(): string {
  return join(getAgentDir(), "trust.json");
}

function normalizeTrustFile(path: string, home: string): void {
  const before = readFileSync(path, "utf-8");
  const after = `${JSON.stringify(normalizeTrust(readTrust(path), home), null, 2)}\n`;
  if (after === before) return;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, after, "utf-8");
  renameSync(temp, path);
}

export default function (pi: ExtensionAPI) {
  const home = canonical(homedir());

  pi.on("project_trust", (event): ProjectTrustEventResult => {
    const decision = findDecision(readTrust(trustPath()), event.cwd, home);
    if (decision === null) return { trusted: "undecided" };
    return { trusted: decision ? "yes" : "no" };
  });

  pi.on("session_start", () => {
    try {
      normalizeTrustFile(trustPath(), home);
    } catch {
      // A missing or unreadable trust file needs no normalization.
    }
  });
}
