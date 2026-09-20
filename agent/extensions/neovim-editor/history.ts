const MAX_ENTRIES = 100;

/** Per-session prompt history, matching the stock Pi editor's in-memory behaviour. */
export class PromptHistory {
  private entries: string[] = [];
  private index = -1;
  private draft = "";

  add(text: string): void {
    const entry = text.trim();
    if (entry.length === 0) return;
    this.entries = [entry, ...this.entries.filter((existing) => existing !== entry)].slice(0, MAX_ENTRIES);
    this.resetNavigation();
  }

  navigate(direction: "previous" | "next", currentText: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.index === -1 && direction === "previous") this.draft = currentText;
    const nextIndex = direction === "previous" ? this.index + 1 : this.index - 1;
    if (nextIndex < -1 || nextIndex >= this.entries.length) return undefined;
    this.index = nextIndex;
    return this.index === -1 ? this.draft : this.entries[this.index];
  }

  resetNavigation(): void {
    this.index = -1;
    this.draft = "";
  }
}
