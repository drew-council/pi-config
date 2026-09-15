import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
  type EditorComponent,
  type EditorTheme,
  type KeyId,
  matchesKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PiAutocompleteController } from "./autocomplete";
import { releaseGlobalDebugHandler } from "./debug-key";
import { PromptHistory } from "./history";
import { NeovimInputParser, toNeovimInput } from "./input";
import { neovimGridHeight } from "./layout";
import { modeLabel } from "./mode";
import { type NeovimEditorState, NeovimHost } from "./nvim-host";

interface NeovimEditorOptions {
  cwd: string;
  notify: (message: string, level: "info" | "error") => void;
  colorizeMode?: (mode: string, label: string) => string;
  history?: PromptHistory;
}

const normalizeKeys = (value: KeyId | KeyId[] | undefined): KeyId[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export class NeovimEditor implements EditorComponent {
  focused = false;
  wantsKeyRelease = false;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  borderColor: (text: string) => string;
  actionHandlers = new Map<AppKeybinding, () => void>();
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;

  private host: NeovimHost;
  private state: NeovimEditorState = {
    lines: [""],
    cursorLine: 0,
    cursorColumn: 0,
    promptBufferActive: true,
    displayHeight: 1,
  };
  private readonly autocomplete: PiAutocompleteController;
  private readonly inputParser = new NeovimInputParser();
  private inputFlushTimer?: ReturnType<typeof setTimeout>;
  private readonly history: PromptHistory;
  private paddingX = 0;
  private started = false;
  private disposed = false;
  private error?: string;
  private lastWidth = 80;
  private lastHeight = 1;
  private restartCount = 0;
  private lastNotifiedText = "";
  private preserveHistoryNavigation = false;
  private readonly previousHardwareCursor: boolean;
  private readonly restoreDebugHandler: () => void;
  private lastCursorShape?: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: EditorTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: NeovimEditorOptions,
  ) {
    this.borderColor = theme.borderColor;
    this.previousHardwareCursor = tui.getShowHardwareCursor();
    // Pi TUI reserves Ctrl+Shift+D for debug logging before focused components
    // receive input. Release it so the configured app.exit binding can route here.
    this.restoreDebugHandler = releaseGlobalDebugHandler(tui);
    tui.setShowHardwareCursor(true);
    this.history = options.history ?? new PromptHistory();
    this.host = this.createHost("");
    this.autocomplete = new PiAutocompleteController({
      tui,
      theme,
      getState: () => this.state,
      applyState: (lines, cursorLine, cursorColumn) => {
        void this.host.setState(lines, cursorLine, cursorColumn);
      },
      submit: () => this.submit(),
    });
  }

  private createHost(initialText: string): NeovimHost {
    return new NeovimHost({
      cwd: this.options.cwd,
      initialText,
      onState: (state) => {
        const previousText = this.state.lines.join("\n");
        this.state = state;
        const nextText = state.lines.join("\n");
        if (nextText !== previousText || nextText !== this.lastNotifiedText) {
          this.lastNotifiedText = nextText;
          this.onChange?.(nextText);
          if (!this.preserveHistoryNavigation) this.history.resetNavigation();
        }
        this.autocomplete?.stateChanged();
        this.tui.requestRender();
      },
      onSubmit: () => this.submit(),
      onRequestExit: () => {
        if (!this.disposed) this.requestAppExit();
      },
      onError: (message) => {
        this.error = message;
        this.options.notify(message, "error");
      },
      onMessage: (message, kind) => {
        const level = /err|^emsg$|^wmsg$/i.test(kind) ? "error" : "info";
        this.options.notify(`nvim: ${message}`, level);
      },
      onExit: (unexpected, message) => {
        if (!unexpected || this.disposed) return;
        if (this.restartCount < 1) {
          this.restartCount += 1;
          this.error = "Neovim exited unexpectedly; restarting once…";
          this.options.notify(this.error, "info");
          const text = this.getText();
          setTimeout(() => {
            if (this.disposed) return;
            this.host = this.createHost(text);
            this.started = true;
            void this.host.start(this.contentWidth(this.lastWidth), this.lastHeight);
          }, 150);
        } else {
          this.error = message || "Neovim exited unexpectedly";
          this.options.notify(this.error, "error");
        }
        this.tui.requestRender();
      },
      onRender: () => {
        this.applyCursorShape();
        this.tui.requestRender();
      },
    });
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  getText(): string {
    return this.state.lines.join("\n");
  }

  getExpandedText(): string {
    return this.getText();
  }

  setText(text: string): void {
    this.autocomplete.cancel();
    this.history.resetNavigation();
    void this.host.setText(text);
  }

  insertTextAtCursor(text: string): void {
    void this.host.insertText(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocomplete.setProvider(provider);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.autocomplete.setMaxVisible(maxVisible);
  }

  setPaddingX(padding: number): void {
    this.paddingX = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
    this.tui.requestRender();
  }

  addToHistory(text: string): void {
    this.history.add(text);
  }

  enableHistoryPersistence(): void {
    this.history.enablePersistence();
  }

  clearHistory(): void {
    this.history.clear();
  }

  render(width: number): string[] {
    this.lastWidth = width;
    this.lastHeight = neovimGridHeight(this.state.displayHeight, this.tui.terminal.rows);
    const contentWidth = this.contentWidth(width);
    if (!this.started) {
      this.started = true;
      void this.host.start(contentWidth, this.lastHeight);
    } else {
      this.host.resize(contentWidth, this.lastHeight);
    }

    const horizontal = this.borderColor("─".repeat(Math.max(1, width)));
    const leftPadding = " ".repeat(Math.min(this.paddingX, Math.floor((width - 1) / 2)));
    const renderContent = (line: string): string => {
      const missing = Math.max(0, contentWidth - visibleWidth(line));
      return `${leftPadding}${line}${" ".repeat(missing)}${leftPadding}`;
    };

    const result = [horizontal];
    const grid = this.host.grid.render(this.focused, !this.tui.getShowHardwareCursor()).slice(0, this.lastHeight);
    if (grid.length > 0) {
      result.push(...grid.map(renderContent));
      this.error = undefined;
    } else {
      const status = this.error ? `Neovim error: ${this.error}` : "Starting embedded Neovim…";
      result.push(
        renderContent(this.error ? this.theme.selectList.noMatch(status) : this.theme.selectList.description(status)),
      );
    }
    result.push(this.renderModeBorder(width));
    result.push(...this.autocomplete.render(contentWidth).map(renderContent));
    return result;
  }

  private renderModeBorder(width: number): string {
    // The mode comes from the host's nvim_get_mode() synchronization, not from
    // redraw events: Neovim's `mode_change` redraw event also encodes
    // cursor-obscuring hints, which would flicker the label to REPLACE while
    // typing in insert mode.
    const mode = this.host.mode;
    const label = ` ${modeLabel(mode)} `;
    if (visibleWidth(label) >= width) return this.borderColor("─".repeat(Math.max(1, width)));
    const border = this.borderColor("─".repeat(width - visibleWidth(label)));
    const styledLabel = this.options.colorizeMode?.(mode, label) ?? `\x1b[7m${this.borderColor(label)}\x1b[27m`;
    return `${border}${styledLabel}`;
  }

  private applyCursorShape(): void {
    const shape = this.host.grid.cursorShape;
    if (shape === this.lastCursorShape) return;
    this.lastCursorShape = shape;
    const code = shape === "vertical" ? 6 : shape === "horizontal" ? 4 : 2;
    this.tui.terminal.write(`\x1b[${code} q`);
  }

  private contentWidth(width: number): number {
    const padding = Math.min(this.paddingX, Math.floor((width - 1) / 2));
    return Math.max(1, width - padding * 2);
  }

  handleInput(data: string): void {
    if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
    this.inputFlushTimer = undefined;
    this.processParsedInput(this.inputParser.push(data));
    if (this.inputParser.hasPendingKeys) {
      this.inputFlushTimer = setTimeout(() => {
        this.inputFlushTimer = undefined;
        this.processParsedInput(this.inputParser.flushPendingKeys());
      }, 10);
    }
  }

  private processParsedInput(inputs: ReturnType<NeovimInputParser["push"]>): void {
    for (const input of inputs) {
      if (input.kind === "paste") this.host.paste(input.value);
      else this.routeKeys(input.value);
    }
  }

  private routeKeys(data: string): void {
    if (this.autocomplete.active) {
      if (this.explicitMatches(data, "tui.select.cancel")) {
        this.autocomplete.handleSelection("cancel");
        return;
      }
      if (this.explicitMatches(data, "tui.select.up")) {
        this.autocomplete.handleSelection("up");
        return;
      }
      if (this.explicitMatches(data, "tui.select.down")) {
        this.autocomplete.handleSelection("down");
        return;
      }
      if (this.explicitMatches(data, "tui.select.pageUp")) {
        this.autocomplete.handleSelection("pageUp");
        return;
      }
      if (this.explicitMatches(data, "tui.select.pageDown")) {
        this.autocomplete.handleSelection("pageDown");
        return;
      }
      if (this.explicitMatches(data, "tui.input.tab")) {
        this.autocomplete.handleSelection("tab");
        return;
      }
      if (this.explicitMatches(data, "tui.select.confirm")) {
        this.autocomplete.handleSelection("confirm");
        return;
      }
    }

    if (this.onExtensionShortcut?.(data)) return;

    if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
      this.onPasteImage?.();
      return;
    }
    if (this.explicitMatches(data, "app.interrupt")) {
      const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
      if (handler) {
        handler();
        return;
      }
    }
    if (this.explicitMatches(data, "app.exit") && this.getText().length === 0) {
      if (this.requestAppExit()) return;
    }
    if (this.explicitMatches(data, "tui.editor.historyPrevious")) {
      this.navigateHistory("previous");
      return;
    }
    if (this.explicitMatches(data, "tui.editor.historyNext")) {
      this.navigateHistory("next");
      return;
    }
    if (this.explicitMatches(data, "tui.input.tab")) {
      this.autocomplete.triggerExplicit();
      return;
    }
    if (this.explicitMatches(data, "tui.input.submit")) {
      this.submit();
      return;
    }

    for (const [action, handler] of this.actionHandlers) {
      if (action !== "app.interrupt" && action !== "app.exit" && this.explicitMatches(data, action)) {
        handler();
        return;
      }
    }

    const input = toNeovimInput(data);
    if (input) this.host.sendKeys(input);
  }

  private explicitMatches(data: string, action: string): boolean {
    const binding = this.keybindings.getUserBindings()[action] as KeyId | KeyId[] | undefined;
    return normalizeKeys(binding).some((key) => matchesKey(data, key));
  }

  private requestAppExit(): boolean {
    const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
    if (!handler) return false;
    handler();
    return true;
  }

  private navigateHistory(direction: "previous" | "next"): void {
    const value = this.history.navigate(direction, this.getText());
    if (value === undefined) return;
    this.preserveHistoryNavigation = true;
    void this.host.setText(value).finally(() => {
      this.preserveHistoryNavigation = false;
    });
  }

  private submit(): void {
    this.autocomplete.cancel();
    const value = this.getText().trim();
    this.history.resetNavigation();
    void this.host.setText("");
    this.lastNotifiedText = "";
    this.onSubmit?.(value);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
    this.autocomplete.cancel();
    await this.host.dispose();
    this.tui.terminal.write("\x1b[0 q");
    this.tui.setShowHardwareCursor(this.previousHardwareCursor);
    this.restoreDebugHandler();
  }
}
