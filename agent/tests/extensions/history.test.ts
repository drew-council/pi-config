import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryNavigator } from "../../extensions/history/navigator";
import { PromptHistoryStore } from "../../extensions/history/store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function historyFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-history-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "prompt-history.json");
}

function readEntries(file: string): string[] {
  return JSON.parse(fs.readFileSync(file, "utf8")).entries;
}

describe("prompt history store", () => {
  test("writes de-duplicated newest-first entries", () => {
    const file = historyFile();
    const store = new PromptHistoryStore(file);

    expect(store.add(" first ")).toEqual(["first"]);
    expect(store.add("second")).toEqual(["second", "first"]);
    expect(store.add("first")).toEqual(["first", "second"]);
    expect(readEntries(file)).toEqual(["first", "second"]);
  });

  test("ignores blank submissions", () => {
    const file = historyFile();
    const store = new PromptHistoryStore(file);

    expect(store.add("   \n ")).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("merges entries written by another session", () => {
    const file = historyFile();
    const store = new PromptHistoryStore(file);
    store.add("mine");
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: ["theirs", "mine"] }));

    expect(store.add("newest")).toEqual(["newest", "theirs", "mine"]);
  });

  test("caps the active window at 100 entries", () => {
    const file = historyFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: Array.from({ length: 150 }, (_value, index) => `entry ${index}`) }),
    );
    const store = new PromptHistoryStore(file);

    const loaded = store.load();
    expect(loaded).toHaveLength(100);
    expect(loaded[0]).toBe("entry 0");
    expect(loaded[99]).toBe("entry 99");
  });

  test("caps the file at 1000 entries", () => {
    const file = historyFile();
    const store = new PromptHistoryStore(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: Array.from({ length: 1000 }, (_value, index) => `entry ${index}`) }),
    );

    store.add("newest");
    const persisted = readEntries(file);
    expect(persisted).toHaveLength(1000);
    expect(persisted[0]).toBe("newest");
    expect(persisted.at(-1)).toBe("entry 998");
  });

  test("tolerates malformed data and atomically replaces it on the next write", () => {
    const file = historyFile();
    fs.writeFileSync(file, "not json");
    const store = new PromptHistoryStore(file);

    expect(store.load()).toEqual([]);
    store.add("usable");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, entries: ["usable"] });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["prompt-history.json"]);
  });

  test("clear truncates the file", () => {
    const file = historyFile();
    const store = new PromptHistoryStore(file);
    store.add("gone");

    store.clear();
    expect(readEntries(file)).toEqual([]);
    expect(store.load()).toEqual([]);
  });
});

describe("prompt history navigation", () => {
  test("walks older entries and restores the draft", () => {
    const navigation = new HistoryNavigator();
    navigation.setEntries(["newest", "older"]);

    expect(navigation.navigate("previous", "draft text")).toBe("newest");
    expect(navigation.navigate("previous", "newest")).toBe("older");
    expect(navigation.navigate("previous", "older")).toBeUndefined();
    expect(navigation.navigate("next", "older")).toBe("newest");
    expect(navigation.navigate("next", "newest")).toBe("draft text");
    expect(navigation.navigate("next", "draft text")).toBeUndefined();
  });

  test("treats an edited buffer as a new draft", () => {
    const navigation = new HistoryNavigator();
    navigation.setEntries(["newest", "older"]);
    navigation.navigate("previous", "");

    expect(navigation.navigate("previous", "newest with edits")).toBe("newest");
    expect(navigation.navigate("next", "newest")).toBe("newest with edits");
  });

  test("does nothing without entries", () => {
    const navigation = new HistoryNavigator();

    expect(navigation.navigate("previous", "draft")).toBeUndefined();
    expect(navigation.navigate("next", "draft")).toBeUndefined();
  });

  test("new entries reset the browsing position", () => {
    const navigation = new HistoryNavigator();
    navigation.setEntries(["newest"]);
    navigation.navigate("previous", "draft");

    navigation.setEntries(["submitted", "newest"]);
    expect(navigation.navigate("previous", "")).toBe("submitted");
  });

  test("drives an editor through get and set text", () => {
    const navigation = new HistoryNavigator();
    navigation.setEntries(["newest", "older"]);
    let text = "draft";
    const step = (direction: "previous" | "next") => {
      const value = navigation.navigate(direction, text);
      if (value !== undefined) text = value;
    };

    step("previous");
    expect(text).toBe("newest");
    step("previous");
    expect(text).toBe("older");
    step("next");
    step("next");
    expect(text).toBe("draft");
  });
});
