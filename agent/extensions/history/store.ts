import * as fs from "node:fs";
import * as path from "node:path";

const HISTORY_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 1000;
const MAX_ACTIVE_ENTRIES = 100;

interface HistoryFile {
  version: number;
  entries: string[];
}

function normalizeEntry(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEntries(entries: unknown, limit = MAX_PERSISTED_ENTRIES): string[] {
  if (!Array.isArray(entries)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    if (typeof value !== "string") continue;
    const entry = normalizeEntry(value);
    if (!entry || seen.has(entry)) continue;
    result.push(entry);
    seen.add(entry);
    if (result.length >= limit) break;
  }
  return result;
}

/** Newest-first prompt history shared by every session through a JSON file. */
export class PromptHistoryStore {
  constructor(private readonly file: string) {}

  load(): string[] {
    return this.read().slice(0, MAX_ACTIVE_ENTRIES);
  }

  /** Persist an entry and return the refreshed window, or undefined when the text is blank. */
  add(text: string): string[] | undefined {
    const entry = normalizeEntry(text);
    if (!entry) return undefined;
    let entries = [entry];
    try {
      entries = [entry, ...this.read().filter((existing) => existing !== entry)];
      this.write(entries);
    } catch {
      // Prompt history must never prevent submission.
    }
    return entries.slice(0, MAX_ACTIVE_ENTRIES);
  }

  clear(): void {
    this.write([]);
  }

  private read(): string[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<HistoryFile>;
      return normalizeEntries(parsed.entries);
    } catch {
      return [];
    }
  }

  private write(entries: string[]): void {
    const payload: HistoryFile = { version: HISTORY_VERSION, entries: normalizeEntries(entries) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.file);
  }
}
