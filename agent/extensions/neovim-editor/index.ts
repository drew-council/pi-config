import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NeovimEditor } from "./editor";

export default function neovimEditorExtension(pi: ExtensionAPI): void {
  const editors = new Set<NeovimEditor>();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new NeovimEditor(tui, theme, keybindings, {
        cwd: ctx.cwd,
        notify: (message, level) => ctx.ui.notify(message, level),
        colorizeMode: (mode, label) => {
          const color = mode.startsWith("insert")
            ? "borderMuted"
            : mode.startsWith("cmdline")
              ? "warning"
              : "borderAccent";
          return ctx.ui.theme.fg(color, `\x1b[7m${label}\x1b[27m`);
        },
      });
      editors.add(editor);
      return editor;
    });
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...editors].map((editor) => editor.dispose()));
    editors.clear();
  });
}
