import { expect, test } from "bun:test";
import type { KeybindingDefinitions, KeybindingsConfig } from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { decideKeyRouting } from "../../extensions/neovim-editor/routing";

const DEFAULT_DEFINITIONS: KeybindingDefinitions = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape", description: "Interrupt current operation" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.clipboard.pasteImage": { defaultKeys: ["alt+v", "ctrl+v"], description: "Paste image from clipboard" },
  "tui.editor.historyPrevious": { defaultKeys: [], description: "Select previous prompt history entry" },
  "tui.editor.historyNext": { defaultKeys: [], description: "Select next prompt history entry" },
};

function makeKeybindings(userBindings?: KeybindingsConfig): KeybindingsManager {
  return new KeybindingsManager(DEFAULT_DEFINITIONS, userBindings);
}

test("empty user config: effective bindings follow Pi defaults", () => {
  const keybindings = makeKeybindings();

  // Enter (\r) routes to submit
  const enterDecision = decideKeyRouting("\r", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(enterDecision).toEqual({ kind: "submit" });

  // Ctrl+D (\x04) routes to exit when prompt is empty
  const exitEmptyDecision = decideKeyRouting("\x04", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: true,
  });
  expect(exitEmptyDecision).toEqual({ kind: "exit" });

  // Ctrl+D (\x04) routes to Neovim when prompt is not empty
  const exitNonEmptyDecision = decideKeyRouting("\x04", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(exitNonEmptyDecision).toEqual({ kind: "neovim", input: "<C-d>" });

  // Escape (\x1b) goes to Neovim in insert mode
  const escapeInsertDecision = decideKeyRouting("\x1b", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(escapeInsertDecision).toEqual({ kind: "neovim", input: "<Esc>" });

  // Escape (\x1b) goes to interrupt in plain normal mode
  const escapeNormalDecision = decideKeyRouting("\x1b", {
    keybindings,
    isPlainNormal: true,
    isEditorEmpty: false,
  });
  expect(escapeNormalDecision).toEqual({ kind: "interrupt" });

  // Shift+Enter (kitty protocol or xterm) routes to Neovim as <CR> via newLine
  const shiftEnterKitty = decideKeyRouting("\x1b[13;2u", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(shiftEnterKitty).toEqual({ kind: "newLine" });

  const shiftEnterLegacy = decideKeyRouting("\x1b[27;2;13~", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(shiftEnterLegacy).toEqual({ kind: "newLine" });

  // Ctrl+J (\x0a) is also bound to newLine by default
  const ctrlJDecision = decideKeyRouting("\x0a", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(ctrlJDecision).toEqual({ kind: "newLine" });

  // Escape closes open autocomplete list rather than going to Neovim or interrupt
  const escapeAutocompleteDecision = decideKeyRouting("\x1b", {
    keybindings,
    autocompleteActive: true,
    isPlainNormal: true,
    isEditorEmpty: false,
  });
  expect(escapeAutocompleteDecision).toEqual({ kind: "autocomplete", action: "cancel" });

  // Ctrl+C clears editor under Pi defaults via app.clear
  const ctrlCDecision = decideKeyRouting("\x03", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
    customActionKeys: ["app.clear"],
  });
  expect(ctrlCDecision).toEqual({ kind: "action", action: "app.clear" });
});

test("custom bindings: submit bound to ctrl+enter lets Enter reach Neovim", () => {
  const keybindings = makeKeybindings({
    "tui.input.submit": "ctrl+enter",
    "app.interrupt": "ctrl+c",
  });

  // Enter (\r) is not submit; it falls through to Neovim as <CR>
  const enterDecision = decideKeyRouting("\r", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(enterDecision).toEqual({ kind: "neovim", input: "<CR>" });

  // Ctrl+Enter submits
  const ctrlEnterDecision = decideKeyRouting("\x1b[13;5u", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(ctrlEnterDecision).toEqual({ kind: "submit" });

  // Ctrl+C interrupts in insert mode when rebound
  const ctrlCInsertDecision = decideKeyRouting("\x03", {
    keybindings,
    isPlainNormal: false,
    isEditorEmpty: false,
  });
  expect(ctrlCInsertDecision).toEqual({ kind: "interrupt" });

  // Escape in plain normal mode goes to Neovim when interrupt is not Escape
  const escapeNormalDecision = decideKeyRouting("\x1b", {
    keybindings,
    isPlainNormal: true,
    isEditorEmpty: false,
  });
  expect(escapeNormalDecision).toEqual({ kind: "neovim", input: "<Esc>" });
});
