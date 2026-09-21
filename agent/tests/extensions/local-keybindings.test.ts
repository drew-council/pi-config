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
});
