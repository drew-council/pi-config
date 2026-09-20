import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { configuredShortcut } from "../shared/configured-shortcuts.js";
import { type HistoryDirection, HistoryNavigator } from "./navigator.js";
import { PromptHistoryStore } from "./store.js";

const PREVIOUS_KEY: KeyId = configuredShortcut("extension.historyPrevious") ?? "ctrl+up";
const NEXT_KEY: KeyId = configuredShortcut("extension.historyNext") ?? "ctrl+down";

export default function promptHistoryExtension(pi: ExtensionAPI): void {
  const store = new PromptHistoryStore(path.join(getAgentDir(), "prompt-history.json"));
  const navigation = new HistoryNavigator();

  pi.on("session_start", () => {
    navigation.setEntries(store.load());
  });

  // Replayed messages do not raise this event, so resuming a session never rewrites entries.
  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    const entries = store.add(event.text);
    if (entries) navigation.setEntries(entries);
  });

  const navigate = (direction: HistoryDirection) => (ctx: ExtensionContext) => {
    const text = navigation.navigate(direction, ctx.ui.getEditorText());
    if (text !== undefined) ctx.ui.setEditorText(text);
  };

  pi.registerShortcut(PREVIOUS_KEY, {
    description: "Previous prompt from global history",
    handler: navigate("previous"),
  });
  pi.registerShortcut(NEXT_KEY, {
    description: "Next prompt from global history",
    handler: navigate("next"),
  });

  pi.registerCommand("history-clear", {
    description: "Clear the persistent global prompt history",
    handler: async (_args, ctx) => {
      try {
        store.clear();
        navigation.setEntries([]);
        ctx.ui.notify("Global prompt history cleared.", "info");
      } catch (error) {
        ctx.ui.notify(
          `Could not clear prompt history: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
