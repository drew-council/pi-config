import { describe, expect, test } from "bun:test";
import { PromptHistory } from "../../extensions/neovim-editor/history";

describe("embedded Neovim prompt history", () => {
  test("keeps de-duplicated newest-first entries and skips blank text", () => {
    const history = new PromptHistory();
    history.add(" first ");
    history.add("   ");
    history.add("second");
    history.add("first");

    expect(history.navigate("previous", "draft")).toBe("first");
    expect(history.navigate("previous", "first")).toBe("second");
    expect(history.navigate("previous", "second")).toBeUndefined();
  });

  test("restores the draft when stepping past the newest entry", () => {
    const history = new PromptHistory();
    history.add("older");
    history.add("newest");

    expect(history.navigate("previous", "draft text")).toBe("newest");
    expect(history.navigate("previous", "newest")).toBe("older");
    expect(history.navigate("next", "older")).toBe("newest");
    expect(history.navigate("next", "newest")).toBe("draft text");
    expect(history.navigate("next", "draft text")).toBeUndefined();
  });

  test("caps the entry list at 100", () => {
    const history = new PromptHistory();
    for (let index = 0; index < 150; index += 1) history.add(`entry ${index}`);

    for (let step = 0; step < 100; step += 1) {
      expect(history.navigate("previous", "")).toBe(`entry ${149 - step}`);
    }
    expect(history.navigate("previous", "")).toBeUndefined();
  });

  test("resets navigation on submit and on demand", () => {
    const history = new PromptHistory();
    history.add("older");
    history.navigate("previous", "draft");

    history.add("newest");
    expect(history.navigate("previous", "")).toBe("newest");

    history.resetNavigation();
    expect(history.navigate("previous", "")).toBe("newest");
  });

  test("does nothing without entries", () => {
    const history = new PromptHistory();
    expect(history.navigate("previous", "draft")).toBeUndefined();
    expect(history.navigate("next", "draft")).toBeUndefined();
  });
});
