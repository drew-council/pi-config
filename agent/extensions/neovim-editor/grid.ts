const CURSOR_MARKER = "\x1b_pi:c\x07";
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal ANSI/APC sequences are control-character protocols.
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07)/g;

function cellWidth(text: string): number {
  let width = 0;
  for (const character of text.replace(TERMINAL_SEQUENCE, "")) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0) || (code >= 0x300 && code <= 0x36f)) continue;
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1faff) ||
        (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1;
  }
  return width;
}

export interface GridCell {
  text: string;
  highlightId: number;
}

export interface HighlightAttributes {
  foreground?: number;
  background?: number;
  special?: number;
  bold?: boolean;
  italic?: boolean;
  reverse?: boolean;
  standout?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
}

interface GridState {
  width: number;
  height: number;
  rows: GridCell[][];
}

interface ModeInfo {
  cursor_shape?: "block" | "horizontal" | "vertical";
  cell_percentage?: number;
}

const emptyCell = (): GridCell => ({ text: " ", highlightId: 0 });
const emptyRow = (width: number): GridCell[] => Array.from({ length: width }, emptyCell);

function ansiColor(prefix: 38 | 48 | 58, value: number | undefined): string | undefined {
  if (value === undefined || value < 0) return undefined;
  return `${prefix};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function ansiForHighlight(attributes: HighlightAttributes | undefined): string {
  if (!attributes) return "\x1b[0m";

  const codes: string[] = ["0"];
  const foreground = ansiColor(38, attributes.foreground);
  const background = ansiColor(48, attributes.background);
  const special = ansiColor(58, attributes.special);
  if (foreground) codes.push(foreground);
  if (background) codes.push(background);
  if (special) codes.push(special);
  if (attributes.bold) codes.push("1");
  if (attributes.italic) codes.push("3");
  if (attributes.underline) codes.push("4");
  if (attributes.underdouble) codes.push("4:2");
  if (attributes.undercurl) codes.push("4:3");
  if (attributes.underdotted) codes.push("4:4");
  if (attributes.underdashed) codes.push("4:5");
  if (attributes.reverse || attributes.standout) codes.push("7");
  if (attributes.strikethrough) codes.push("9");
  return `\x1b[${codes.join(";")}m`;
}

/** State machine for Neovim's ext_linegrid redraw protocol. */
export class NeovimGrid {
  private readonly grids = new Map<number, GridState>();
  private readonly highlights = new Map<number, HighlightAttributes>();
  private cursorGrid = 1;
  private cursorRow = 0;
  private cursorColumn = 0;
  private cursorStyleEnabled = false;
  private modeInfos: ModeInfo[] = [];
  private modeIndex = 0;
  private externalCommandLine?: { text: string; cursorColumn: number };
  private frameVersion = 0;

  onFlush?: () => void;

  get version(): number {
    return this.frameVersion;
  }

  get cursorShape(): "block" | "horizontal" | "vertical" {
    if (!this.cursorStyleEnabled) return "block";
    return this.modeInfos[this.modeIndex]?.cursor_shape ?? "block";
  }

  get cursorCellPercentage(): number {
    return this.modeInfos[this.modeIndex]?.cell_percentage ?? 100;
  }

  get size(): { width: number; height: number } {
    const grid = this.grids.get(1);
    return { width: grid?.width ?? 0, height: grid?.height ?? 0 };
  }

  setExternalCommandLine(text: string | undefined, cursorColumn = 0): void {
    this.externalCommandLine = text === undefined ? undefined : { text, cursorColumn: Math.max(0, cursorColumn) };
  }

  handleRedraw(events: unknown[]): void {
    for (const event of events) {
      if (!Array.isArray(event) || typeof event[0] !== "string") continue;
      const [name, ...calls] = event;
      for (const call of calls) {
        if (!Array.isArray(call)) continue;
        this.handleEvent(name, call);
      }
    }
  }

  private handleEvent(name: string, args: unknown[]): void {
    switch (name) {
      case "grid_resize":
        this.resize(Number(args[0]), Number(args[1]), Number(args[2]));
        break;
      case "grid_clear":
        this.clear(Number(args[0]));
        break;
      case "grid_destroy":
        this.grids.delete(Number(args[0]));
        break;
      case "grid_line":
        this.line(Number(args[0]), Number(args[1]), Number(args[2]), args[3]);
        break;
      case "grid_scroll":
        this.scroll(
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3]),
          Number(args[4]),
          Number(args[5]),
          Number(args[6]),
        );
        break;
      case "grid_cursor_goto":
        this.cursorGrid = Number(args[0]);
        this.cursorRow = Number(args[1]);
        this.cursorColumn = Number(args[2]);
        break;
      case "hl_attr_define":
        this.highlights.set(Number(args[0]), (args[1] ?? {}) as HighlightAttributes);
        break;
      case "mode_info_set":
        this.cursorStyleEnabled = Boolean(args[0]);
        this.modeInfos = Array.isArray(args[1]) ? (args[1] as ModeInfo[]) : [];
        break;
      case "mode_change":
        // Only the index is tracked here, for cursor styling. The event's mode
        // name must NOT be treated as the editor mode: Neovim reuses it as a
        // cursor-style hint and reports "replace" whenever the cursor is
        // obscured by an overlay grid (completion popup, message, ...) even
        // though the mode did not change. The true mode comes from
        // nvim_get_mode(), fetched by the host's state synchronization.
        this.modeIndex = Number(args[1] ?? 0);
        break;
      case "flush":
        this.frameVersion += 1;
        this.onFlush?.();
        break;
      default:
        // Forward-compatible: Neovim adds redraw events over time. Events for
        // extensions we did not request must not crash the prompt editor.
        break;
    }
  }

  private resize(id: number, width: number, height: number): void {
    if (width < 1 || height < 1) return;
    const existing = this.grids.get(id);
    const rows = Array.from({ length: height }, (_, row) => {
      const previous = existing?.rows[row] ?? [];
      return Array.from({ length: width }, (_, column) => previous[column] ?? emptyCell());
    });
    this.grids.set(id, { width, height, rows });
  }

  private clear(id: number): void {
    const grid = this.grids.get(id);
    if (!grid) return;
    grid.rows = Array.from({ length: grid.height }, () => emptyRow(grid.width));
  }

  private line(id: number, row: number, column: number, rawCells: unknown): void {
    const grid = this.grids.get(id);
    if (!grid || row < 0 || row >= grid.height || !Array.isArray(rawCells)) return;

    let targetColumn = column;
    let inheritedHighlight = 0;
    for (const rawCell of rawCells) {
      if (!Array.isArray(rawCell)) continue;
      const text = String(rawCell[0] ?? "");
      if (rawCell.length > 1 && rawCell[1] !== undefined) inheritedHighlight = Number(rawCell[1]);
      // Neovim uses a trailing space with repeat=0 as a line-state sentinel.
      // It carries no cell update and must not erase the cell under the cursor.
      const repeat = Math.max(0, Number(rawCell[2] ?? 1));
      for (let count = 0; count < repeat && targetColumn < grid.width; count += 1) {
        if (targetColumn >= 0) grid.rows[row][targetColumn] = { text, highlightId: inheritedHighlight };
        targetColumn += 1;
      }
    }
  }

  private scroll(
    id: number,
    top: number,
    bottom: number,
    left: number,
    right: number,
    rowOffset: number,
    columnOffset: number,
  ): void {
    const grid = this.grids.get(id);
    if (!grid) return;
    const source = grid.rows.map((row) => row.map((cell) => ({ ...cell })));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const sourceRow = row + rowOffset;
        const sourceColumn = column + columnOffset;
        grid.rows[row][column] =
          sourceRow >= top && sourceRow < bottom && sourceColumn >= left && sourceColumn < right
            ? { ...source[sourceRow][sourceColumn] }
            : emptyCell();
      }
    }
  }

  render(focused: boolean, softwareCursor = true): string[] {
    const grid = this.grids.get(1);
    if (!grid) return [];

    const rows = grid.rows.map((row, rowIndex) => {
      let output = "";
      let activeHighlight = -1;
      for (let column = 0; column < grid.width; column += 1) {
        const cell = row[column] ?? emptyCell();
        if (cell.highlightId !== activeHighlight) {
          output += ansiForHighlight(this.highlights.get(cell.highlightId));
          activeHighlight = cell.highlightId;
        }
        const hasCursor =
          focused && this.cursorGrid === 1 && rowIndex === this.cursorRow && column === this.cursorColumn;
        if (hasCursor) output += CURSOR_MARKER;
        if (hasCursor && softwareCursor) output += "\x1b[7m";
        output += cell.text;
        if (hasCursor && softwareCursor) output += ansiForHighlight(this.highlights.get(cell.highlightId));
      }
      output += "\x1b[0m";
      const missing = grid.width - cellWidth(output);
      return missing > 0 ? `${output}${" ".repeat(missing)}` : output;
    });

    // ext_messages also externalizes Neovim's command line. Keep it visible
    // in the normal grid's final row so ex/search commands retain their native
    // prompt behavior while messages can be surfaced by Pi.
    if (this.externalCommandLine && rows.length > 0) {
      rows[rows.length - 1] = this.renderExternalCommandLine(grid.width, focused, softwareCursor);
    }
    return rows;
  }

  private renderExternalCommandLine(width: number, focused: boolean, softwareCursor: boolean): string {
    const commandLine = this.externalCommandLine;
    if (!commandLine) return " ".repeat(width);

    // Neovim gives us a string-column cursor position. Show the cursor and
    // retain the tail nearest it when the command exceeds the prompt width.
    const cursor = Math.min(commandLine.cursorColumn, commandLine.text.length);
    const start = Math.max(0, cursor - width + 1);
    const text = commandLine.text.slice(start, start + width);
    const cursorInView = cursor - start;
    let output = "";
    for (let column = 0; column < width; column += 1) {
      const hasCursor = focused && column === cursorInView;
      if (hasCursor) output += CURSOR_MARKER;
      if (hasCursor && softwareCursor) output += "\x1b[7m";
      output += text[column] ?? " ";
      if (hasCursor && softwareCursor) output += "\x1b[27m";
    }
    return `${output}\x1b[0m`;
  }
}
