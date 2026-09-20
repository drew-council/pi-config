import { expect, test } from "bun:test";
import { NeovimHost } from "../../extensions/neovim-editor/nvim-host";

// biome-ignore lint/suspicious/noControlCharactersInRegex: this strips terminal protocol sequences from assertions.
const terminalSequence = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07)/g;
const stripAnsi = (value: string) => value.replace(terminalSequence, "");

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for embedded Neovim state");
    await Bun.sleep(10);
  }
}

test("a real embedded Neovim owns editing, state synchronization, and shutdown", async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  let latestDisplayHeight = 0;
  let exitRequests = 0;
  const errors: string[] = [];
  const messages: Array<{ text: string; kind: string }> = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
      latestDisplayHeight = state.displayHeight;
    },
    onSubmit: () => undefined,
    onRequestExit: () => {
      exitRequests += 1;
    },
    onError: (message) => errors.push(message),
    onMessage: (text, kind) => messages.push({ text, kind }),
    onExit: () => undefined,
    onRender: () => undefined,
  });

  try {
    await host.start(50, 8);
    expect(host.isReady).toBe(true);
    expect(host.grid.size).toEqual({ width: 50, height: 8 });
    expect(latestDisplayHeight).toBe(1);
    await waitFor(() => host.grid.cursorShape === "vertical");
    expect(host.mode).toBe("insert");
    expect(host.isPlainNormal).toBe(false);

    host.resize(12, 8);
    await waitFor(() => host.grid.size.width === 12);
    await host.setState(["abcdefghijklmnopqrstuvwx"], 0, 0);
    await waitFor(() => latestText === "abcdefghijklmnopqrstuvwx" && latestDisplayHeight > 1);
    await host.setText("");
    host.resize(50, 8);
    await waitFor(() => host.grid.size.width === 50 && latestText === "");

    expect(host.grid.cursorShape).toBe("vertical");
    const insertFrame = host.grid.render(false).join("\n");
    expect(insertFrame).not.toContain("-- INSERT --");
    expect(insertFrame).not.toContain("[Pi Prompt]");
    host.sendKeys("hello world<Esc>0dw");
    await waitFor(() => latestText === "world");
    expect(host.text).toBe("world");
    expect(host.grid.cursorShape).toBe("block");

    host.sendKeys(":");
    await waitFor(() => host.mode.startsWith("cmdline"));
    expect(host.isPlainNormal).toBe(false);
    expect(host.grid.render(false).join("\n")).toContain(":");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");
    expect(host.isPlainNormal).toBe(true);

    host.sendKeys(":echoerr 'Pi message test'<CR>");
    await waitFor(() => messages.some(({ text }) => text.includes("Pi message test")));
    expect(messages.at(-1)?.kind).toMatch(/err|emsg/i);

    await host.setState(["emoji 😀", "second"], 0, 8);
    await waitFor(() => latestText === "emoji 😀\nsecond" && latestDisplayHeight === 2);
    await host.insertText("!");
    await waitFor(() => latestText === "emoji 😀!\nsecond");

    await host.setState(["test 1234 hello"], 0, 0);
    host.sendKeys("v");
    await waitFor(() => host.mode === "visual" && host.grid.cursorShape === "block");
    expect(host.isPlainNormal).toBe(false);
    expect(host.grid.cursorShape).toBe("block");
    const visualFrame = host.grid.version;
    host.sendKeys("w");
    await waitFor(() => host.grid.version > visualFrame);
    expect(stripAnsi(host.grid.render(false)[0])).toContain("test 1234 hello");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");
    expect(host.isPlainNormal).toBe(true);

    // Real replace mode must be reported as such (distinct from Neovim's
    // cursor-obscured "replace" redraw hint, which must never flip the label).
    host.sendKeys("R");
    await waitFor(() => host.mode === "replace");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");

    await host.setText("");
    await waitFor(() => latestText === "" && host.mode === "insert");
    expect(host.grid.cursorShape).toBe("vertical");
    expect(host.mode).toBe("insert");

    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
  expect(exitRequests).toBe(0);
});

test('Neovim\'s cursor-obscured "replace" hint never flips the insert-mode indicator', async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
    },
    onSubmit: () => undefined,
    onRequestExit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });
  const hints: string[] = [];
  const originalHandleRedraw = host.grid.handleRedraw.bind(host.grid);
  host.grid.handleRedraw = (events: unknown[]) => {
    for (const event of events as unknown[][]) {
      if (event?.[0] === "mode_change") hints.push(JSON.stringify(event[1]));
    }
    originalHandleRedraw(events);
  };

  try {
    await host.start(30, 3);
    await waitFor(() => host.mode === "insert");
    await host.setState(["hello"], 0, 5);
    await waitFor(() => latestText === "hello");

    // A float covering the cursor makes Neovim emit its cursor-obscured
    // `mode_change` ["replace", 3] hint even though the editor stays in insert
    // mode. The float is deferred so it lands after the return to insert.
    hints.length = 0;
    const openFloat =
      "vim.defer_fn(function() local b = vim.api.nvim_create_buf(false, true) vim.api.nvim_open_win(b, false, { relative = 'editor', row = 0, col = 0, width = 30, height = 3, style = 'minimal', zindex = 300 }) end, 100)";
    host.sendKeys(`<Esc>:lua ${openFloat}<CR>i`);
    await waitFor(() => hints.some((hint) => hint.includes("replace")));
    await Bun.sleep(100); // allow the state sync following the hint to land
    expect(host.mode).toBe("insert");

    host.sendKeys("\x1b\x1b");
    await waitFor(() => host.mode === "normal");
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("the editor bottom stays filled: no '~' filler rows below the buffer end", async () => {
  if (!Bun.which("nvim")) return;

  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: () => undefined,
    onSubmit: () => undefined,
    onRequestExit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });
  // Trailing rows Neovim paints with its '~' end-of-buffer marker are wasted
  // prompt space and must never render. The viewport normalization runs inside
  // Neovim before the redraw flush, so filler should never even reach the grid.
  const fillerRows = () => {
    const rows = host.grid.render(false).map(stripAnsi);
    let dead = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].trimStart().startsWith("~")) dead++;
      else break;
    }
    return dead;
  };
  const makeLines = async (count: number): Promise<string[]> => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(`L${i + 1} ${"word ".repeat(17)}`.trimEnd());
    lines.push(""); // empty cursor line, like a real prompt
    return lines;
  };
  // The editor resizes the grid to min(wrapped content height, viewport cap)
  // on every render; mirror that here.
  const syncBox = (cap = 15) => host.resize(80, Math.min(host.editorState.displayHeight, cap));

  try {
    await host.start(80, 12);
    await host.setState(await makeLines(40), 40, 0);
    await waitFor(() => fillerRows() === 0);

    // Window growth keeps the old view top and would expose filler rows.
    for (const height of [13, 14, 15]) {
      host.resize(80, height);
      await waitFor(() => fillerRows() === 0);
    }

    // Shrink then regrow.
    host.resize(80, 12);
    await waitFor(() => fillerRows() === 0);
    host.resize(80, 15);
    await waitFor(() => fillerRows() === 0);

    // zt pulls the cursor line to the window top: maximal filler below.
    host.sendKeys("<Esc>zt");
    await waitFor(() => fillerRows() === 0);

    // Scroll up, then back to the end.
    host.sendKeys("<Esc>5<C-u>G");
    await waitFor(() => fillerRows() === 0);

    // Shrinking the wrapped last line leaves filler with no WinScrolled event;
    // the state synchronization must re-pin the viewport.
    host.sendKeys("i");
    await Bun.sleep(100);
    host.sendKeys("tail text that is quite long and will definitely wrap around the window edge several times here ok");
    await waitFor(() => fillerRows() === 0);
    for (let i = 0; i < 14; i++) host.sendKeys("<C-w>");
    await waitFor(() => fillerRows() === 0);

    // Full buffer replacement with far fewer lines; the box shrinks with it.
    await host.setState(await makeLines(6), 6, 0);
    syncBox();
    await waitFor(() => fillerRows() === 0);

    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("the prompt viewport never scrolls past the end of the buffer", async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
    },
    onSubmit: () => undefined,
    onRequestExit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });
  const renderedRows = () => host.grid.render(false).map((line) => stripAnsi(line).trimEnd());

  try {
    await host.start(20, 2);
    await host.setState(["one", "two", "three"], 2, 0);
    await waitFor(() => latestText === "one\ntwo\nthree" && renderedRows().join("|") === "two|three");

    host.resize(20, 3);
    await waitFor(() => host.grid.size.height === 3 && renderedRows().join("|") === "one|two|three");

    const version = host.grid.version;
    host.sendKeys("<Esc><C-E>");
    await waitFor(() => host.grid.version > version);
    await waitFor(() => renderedRows().join("|") === "one|two|three");

    expect(renderedRows()).toEqual(["one", "two", "three"]);
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("Neovim :q requests Pi exit instead of reporting an unexpected child exit", async () => {
  if (!Bun.which("nvim")) return;

  let exitRequests = 0;
  const childExits: boolean[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: () => undefined,
    onSubmit: () => undefined,
    onRequestExit: () => {
      exitRequests += 1;
    },
    onError: () => undefined,
    onExit: (unexpected) => childExits.push(unexpected),
    onRender: () => undefined,
  });

  try {
    await host.start(40, 6);
    host.sendKeys("<Esc>:q<CR>");
    await waitFor(() => childExits.length === 1);

    expect(exitRequests).toBe(1);
    expect(childExits).toEqual([false]);
  } finally {
    await host.dispose();
  }
});
