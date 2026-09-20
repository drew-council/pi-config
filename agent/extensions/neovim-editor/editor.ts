import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
  type EditorComponent,
  type EditorTheme,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PiAutocompleteController } from "./autocomplete";
import { PromptHistory } from "./history";
import { NeovimInputParser, toNeovimInput } from "./input";
import { neovimGridHeight } from "./layout";
import { modeLabel } from "./mode";
import { type NeovimEditorState, NeovimHost } from "./nvim-host";
import { decideAutocompleteKey, decideKeyRouting } from "./routing";

interface NeovimEditorOptions {
  cwd: string;
  notify: (message: string, level: "info" | "error") => void;
  colorizeMode?: (mode: string, label: string) => string;
}

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
  private readonly history = new PromptHistory();
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
  private lastCursorShape?: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: EditorTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: NeovimEditorOptions,
  ) {
    this.borderColor = theme.borderColor;
    this.previousHardwareCursor = tui.getShowHardwareCursor();
    tui.setShowHardwareCursor(true);
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

  render(width: number): string[] {
    // Pi re-applies the `showHardwareCursor` user setting (default false) after
    // extension reload via handleReloadCommand → applyRuntimeSettings, which
    // runs *after* session_start has constructed this editor. Left uncorrected,
    // the hidden hardware cursor demotes the grid to its software
    // reverse-video cursor, so Neovim's insert/replace shapes stop rendering.
    // Re-assert on every frame; the TUI setter is a no-op when unchanged.
    if (!this.tui.getShowHardwareCursor()) this.tui.setShowHardwareCursor(true);
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
      const autoAction = decideAutocompleteKey(data, this.keybindings);
      if (autoAction) {
        this.autocomplete.handleSelection(autoAction);
        return;
      }
    }

    if (this.onExtensionShortcut?.(data)) return;

    const decision = decideKeyRouting(data, {
      keybindings: this.keybindings,
      autocompleteActive: false,
      isPlainNormal: this.host.isPlainNormal,
      isEditorEmpty: this.getText().length === 0,
      customActionKeys: [...this.actionHandlers.keys()],
    });

    switch (decision.kind) {
      case "autocomplete":
        this.autocomplete.handleSelection(decision.action);
        return;
      case "pasteImage":
        this.onPasteImage?.();
        return;
      case "interrupt": {
        const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
        handler?.();
        return;
      }
      case "exit":
        this.requestAppExit();
        return;
      case "history":
        this.navigateHistory(decision.direction);
        return;
      case "tab":
        this.autocomplete.triggerExplicit();
        return;
      case "newLine":
        this.host.sendKeys("<CR>");
        return;
      case "submit":
        this.submit();
        return;
      case "action": {
        const handler = this.actionHandlers.get(decision.action);
        handler?.();
        return;
      }
      case "neovim": {
        const input = decision.input ?? toNeovimInput(data);
        if (input) this.host.sendKeys(input);
        return;
      }
    }
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
  }
}
