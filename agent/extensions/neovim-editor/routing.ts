import type { AppKeybinding } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, matchesKey } from "@earendil-works/pi-tui";
import { toNeovimInput } from "./input";

export type AutocompleteAction = "cancel" | "up" | "down" | "pageUp" | "pageDown" | "tab" | "confirm";

export interface KeyRoutingContext {
  keybindings: KeybindingsManager;
  autocompleteActive?: boolean;
  isPlainNormal: boolean;
  isEditorEmpty: boolean;
  customActionKeys?: AppKeybinding[];
}

export type KeyRoutingDecision =
  | { kind: "autocomplete"; action: AutocompleteAction }
  | { kind: "pasteImage" }
  | { kind: "interrupt" }
  | { kind: "exit" }
  | { kind: "history"; direction: "previous" | "next" }
  | { kind: "tab" }
  | { kind: "newLine" }
  | { kind: "submit" }
  | { kind: "action"; action: AppKeybinding }
  | { kind: "neovim"; input?: string };

export function decideAutocompleteKey(data: string, keybindings: KeybindingsManager): AutocompleteAction | undefined {
  if (keybindings.matches(data, "tui.select.cancel")) return "cancel";
  if (keybindings.matches(data, "tui.select.up")) return "up";
  if (keybindings.matches(data, "tui.select.down")) return "down";
  if (keybindings.matches(data, "tui.select.pageUp")) return "pageUp";
  if (keybindings.matches(data, "tui.select.pageDown")) return "pageDown";
  if (keybindings.matches(data, "tui.input.tab")) return "tab";
  if (keybindings.matches(data, "tui.select.confirm")) return "confirm";
  return undefined;
}

export function decideKeyRouting(data: string, context: KeyRoutingContext): KeyRoutingDecision {
  if (context.autocompleteActive) {
    const action = decideAutocompleteKey(data, context.keybindings);
    if (action) return { kind: "autocomplete", action };
  }

  if (context.keybindings.matches(data, "app.clipboard.pasteImage")) {
    return { kind: "pasteImage" };
  }

  const isEscapeKey = matchesKey(data, "escape");
  if (isEscapeKey) {
    if (!context.isPlainNormal) {
      // In any mode other than plain normal mode, Escape goes to Neovim.
      return { kind: "neovim", input: toNeovimInput(data) };
    }

    // In plain normal mode, Escape is a no-op for Neovim. Hand it to whatever Pi action it resolves to.
    if (context.keybindings.matches(data, "app.interrupt")) {
      return { kind: "interrupt" };
    }
    if (context.keybindings.matches(data, "app.exit") && context.isEditorEmpty) {
      return { kind: "exit" };
    }
    if (context.customActionKeys) {
      for (const action of context.customActionKeys) {
        if (action !== "app.interrupt" && action !== "app.exit" && context.keybindings.matches(data, action)) {
          return { kind: "action", action };
        }
      }
    }
    return { kind: "neovim", input: toNeovimInput(data) };
  }

  if (context.keybindings.matches(data, "app.interrupt")) {
    return { kind: "interrupt" };
  }

  if (context.keybindings.matches(data, "app.exit") && context.isEditorEmpty) {
    return { kind: "exit" };
  }

  if (context.keybindings.matches(data, "tui.editor.historyPrevious")) {
    return { kind: "history", direction: "previous" };
  }

  if (context.keybindings.matches(data, "tui.editor.historyNext")) {
    return { kind: "history", direction: "next" };
  }

  if (context.keybindings.matches(data, "tui.input.tab")) {
    return { kind: "tab" };
  }

  if (context.keybindings.matches(data, "tui.input.newLine")) {
    return { kind: "newLine" };
  }

  if (context.keybindings.matches(data, "tui.input.submit")) {
    return { kind: "submit" };
  }

  if (context.customActionKeys) {
    for (const action of context.customActionKeys) {
      if (action !== "app.interrupt" && action !== "app.exit" && context.keybindings.matches(data, action)) {
        return { kind: "action", action };
      }
    }
  }

  return { kind: "neovim", input: toNeovimInput(data) };
}
