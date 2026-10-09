import { expect, test } from "bun:test";

test("local keybindings preserve expected personal action chords", async () => {
  const keybindings = (await Bun.file(new URL("../../keybindings.json", import.meta.url)).json()) as Record<
    string,
    string | string[]
  >;

  expect(keybindings["tui.input.submit"]).toBe("ctrl+enter");
  expect(keybindings["app.interrupt"]).toBe("ctrl+c");
  expect(keybindings["app.exit"]).toEqual([]);
  expect(keybindings["app.clipboard.pasteImage"]).toBe("ctrl+v");

  // History uses readline chords: macOS eats ctrl+up/down for Mission Control.
  expect(keybindings["extension.historyPrevious"]).toBe("ctrl+p");
  expect(keybindings["extension.historyNext"]).toBe("ctrl+n");

  // ctrl+p must be free for the history extension, which loses to reserved
  // built-in bindings, so model cycling is unbound (use the ctrl+l picker).
  expect(keybindings["app.model.cycleForward"]).toEqual([]);
  expect(keybindings["app.model.cycleBackward"]).toEqual([]);
});
