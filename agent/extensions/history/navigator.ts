export type HistoryDirection = "previous" | "next";

/** Per-session browsing position over the shared history window. */
export class HistoryNavigator {
  private entries: string[] = [];
  private index = -1;
  private draft = "";
  private lastWritten?: string;

  setEntries(entries: string[]): void {
    this.entries = entries;
    this.reset();
  }

  /** Returns the text to place in the editor, or undefined when the step is not possible. */
  navigate(direction: HistoryDirection, currentText: string): string | undefined {
    if (currentText !== this.lastWritten) {
      this.index = -1;
      this.draft = currentText;
    }
    if (this.entries.length === 0) return undefined;
    const nextIndex = direction === "previous" ? this.index + 1 : this.index - 1;
    if (nextIndex < -1 || nextIndex >= this.entries.length) return undefined;
    this.index = nextIndex;
    const text = nextIndex === -1 ? this.draft : this.entries[nextIndex];
    this.lastWritten = text;
    return text;
  }

  reset(): void {
    this.index = -1;
    this.draft = "";
    this.lastWritten = undefined;
  }
}
