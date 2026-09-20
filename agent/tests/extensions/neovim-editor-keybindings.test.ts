import { expect, test } from "bun:test";

test("embedded editor keeps Pi-owned actions on their configured chords", async () => {
  const keybindings = (await Bun.file(new URL("../../keybindings.json", import.meta.url)).json()) as Record<
    string,
    string | string[]
  >;

  expect(keybindings["app.exit"]).toEqual([]);
  expect(keybindings["app.clipboard.pasteImage"]).toBe("ctrl+v");
});
