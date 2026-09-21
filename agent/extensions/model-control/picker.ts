import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type KeybindingsManager, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ProfileName } from "../shared/accounts.js";
import type { ModelEffortPreference } from "./preferences.js";
import { compareByRecentUsage, type ModelEffortKey, pairKey } from "./usage.js";

export type ModelEffortPair = ModelEffortKey & { modelObject: Model<Api>; name?: string };
export type PickerResult = { pair: ModelEffortPair; save: boolean };

type ScopedModel = ExtensionContext["scopedModels"][number];
type PickerTheme = {
  fg(color: "accent" | "muted" | "dim" | "warning" | "error" | "success", text: string): string;
};

export function expandModelEffortPairs(
  models: readonly Model<Api>[],
  scopedModels?: readonly ScopedModel[],
): ModelEffortPair[] {
  const pinned = scopedModels
    ? new Map(scopedModels.map((entry) => [`${entry.model.provider}\0${entry.model.id}`, entry.thinkingLevel]))
    : undefined;
  return models.flatMap((model) => {
    const fixed = pinned?.get(`${model.provider}\0${model.id}`);
    const levels = fixed ? [fixed as ModelThinkingLevel] : getSupportedThinkingLevels(model);
    return levels.map((thinking) => ({
      provider: model.provider,
      model: model.id,
      thinking,
      modelObject: model,
      name: model.name,
    }));
  });
}

export function sortModelEffortPairs(
  pairs: readonly ModelEffortPair[],
  recent: ReadonlyMap<string, number>,
): ModelEffortPair[] {
  return [...pairs].sort((a, b) => compareByRecentUsage(a, b, recent));
}

export function modelEffortSearchText(pair: ModelEffortPair): string {
  return `${pair.provider}/${pair.model}:${pair.thinking} ${pair.model}:${pair.thinking} ${pair.provider} ${pair.model} ${pair.name ?? ""} ${pair.thinking} thinking reasoning effort`;
}

export function filterModelEffortPairs(pairs: readonly ModelEffortPair[], query: string): ModelEffortPair[] {
  return query.trim() ? [...fuzzyFilter([...pairs], query, modelEffortSearchText)] : [...pairs];
}

class ModelEffortPicker extends Container {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private allPairs: ModelEffortPair[] = [];
  private scopedPairs: ModelEffortPair[] = [];
  private filtered: ModelEffortPair[] = [];
  private selectedIndex = 0;
  private scope: "all" | "scoped";
  private closed = false;
  private readonly refreshController = new AbortController();
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: PickerTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly current: ModelEffortPreference | undefined,
    private readonly defaultPair: ModelEffortPreference,
    allModels: readonly Model<Api>[],
    scopedModels: readonly ScopedModel[],
    private readonly recent: ReadonlyMap<string, number>,
    private readonly done: (result: PickerResult | undefined) => void,
    initialSearchInput?: string,
    refresh?: (signal: AbortSignal) => Promise<readonly Model<Api>[]>,
  ) {
    super();
    this.scope = scopedModels.length > 0 ? "scoped" : "all";
    this.setModels(allModels, scopedModels);
    this.addChild(new Text(theme.fg("muted", "Model + reasoning effort"), 0, 0));
    if (scopedModels.length > 0) {
      this.addChild(new Text(theme.fg("dim", "Tab toggles scoped/all models"), 0, 0));
    }
    this.addChild(new Spacer(1));
    if (initialSearchInput) this.searchInput.setValue(initialSearchInput);
    this.searchInput.onSubmit = () => this.select(false);
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("dim", "Enter select · Ctrl+S select and save profile default · Esc cancel"), 0, 0),
    );
    this.applyFilter();
    if (refresh) {
      void refresh(this.refreshController.signal)
        .then((models) => {
          if (this.closed) return;
          const refreshedScoped = scopedModels
            .map((entry) => {
              const model = models.find(
                (candidate) => candidate.provider === entry.model.provider && candidate.id === entry.model.id,
              );
              return model ? { ...entry, model } : undefined;
            })
            .filter((entry): entry is ScopedModel => Boolean(entry));
          this.setModels(models, refreshedScoped);
          this.applyFilter();
          this.tui.requestRender();
        })
        .catch(() => {});
    }
  }

  private setModels(models: readonly Model<Api>[], scopedModels: readonly ScopedModel[]): void {
    this.allPairs = sortModelEffortPairs(expandModelEffortPairs(models), this.recent);
    this.scopedPairs = sortModelEffortPairs(
      expandModelEffortPairs(
        scopedModels.map((entry) => entry.model),
        scopedModels,
      ),
      this.recent,
    );
  }

  private activePairs(): ModelEffortPair[] {
    return this.scope === "scoped" ? this.scopedPairs : this.allPairs;
  }

  private applyFilter(): void {
    this.filtered = filterModelEffortPairs(this.activePairs(), this.searchInput.getValue());
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    if (this.searchInput.getValue()) this.selectedIndex = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.clear();
    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching model/effort pairs"), 0, 0));
      return;
    }
    const maxVisible = 12;
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible),
    );
    const end = Math.min(start + maxVisible, this.filtered.length);
    for (let index = start; index < end; index++) {
      const pair = this.filtered[index];
      if (!pair) continue;
      const selected = index === this.selectedIndex;
      const current = this.current && pairKey(pair) === pairKey(this.current);
      const saved = pairKey(pair) === pairKey(this.defaultPair);
      const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
      const check = current ? this.theme.fg("accent", "✓ ") : "  ";
      const label = `${pair.model} · ${pair.thinking}`;
      const model = selected ? this.theme.fg("accent", label) : label;
      const provider = this.theme.fg("muted", `[${pair.provider}]`);
      const badge = saved ? this.theme.fg("dim", " · default") : "";
      this.list.addChild(new Text(`${cursor}${check}${model} ${provider}${badge}`, 0, 0));
    }
    if (start > 0 || end < this.filtered.length) {
      this.list.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
      );
    }
    const selected = this.filtered[this.selectedIndex];
    if (selected?.name) {
      this.list.addChild(new Spacer(1));
      this.list.addChild(new Text(this.theme.fg("muted", `  ${selected.name}`), 0, 0));
    }
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.tab") && this.scopedPairs.length > 0) {
      this.scope = this.scope === "all" ? "scoped" : "all";
      this.selectedIndex = 0;
      this.applyFilter();
    } else if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.renderList();
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.renderList();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.select(false);
    } else if (this.keybindings.matches(data, "app.models.save")) {
      this.select(true);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done(undefined);
    } else {
      this.searchInput.handleInput(data);
      this.applyFilter();
    }
    this.tui.requestRender();
  }

  private select(save: boolean): void {
    const pair = this.filtered[this.selectedIndex];
    if (!pair) return;
    this.dispose();
    this.done({ pair, save });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.refreshController.abort();
  }
}

export type OpenModelEffortPicker = (ctx: ExtensionContext, initialSearchInput?: string) => Promise<void> | void;

const pickerMarker = Symbol.for("pi.model-control.picker");
type PickerPatchState = { open: OpenModelEffortPicker };
type InteractiveTarget = {
  showModelSelector(initialSearchInput?: string): void;
  handleModelCommand(searchTerm?: string): Promise<void> | void;
  [pickerMarker]?: PickerPatchState;
};
type InteractiveInstance = { session: AgentSession };

/** Replace the one native selector entrypoint used by both /model and Ctrl+L. */
export function installModelEffortPicker(target: InteractiveTarget, open: OpenModelEffortPicker): void {
  const existing = target[pickerMarker];
  if (existing) {
    existing.open = open;
    return;
  }
  const state: PickerPatchState = { open };
  target.showModelSelector = function (this: InteractiveInstance, initialSearchInput?: string) {
    const ctx = this.session.extensionRunner.createContext();
    void Promise.resolve(state.open(ctx, initialSearchInput)).catch((error: unknown) => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
  };
  target.handleModelCommand = function (this: InteractiveInstance, searchTerm?: string) {
    target.showModelSelector.call(this as unknown as InteractiveTarget, searchTerm);
  };
  target[pickerMarker] = state;
}

export async function showModelEffortPicker(options: {
  ctx: ExtensionContext;
  profile: ProfileName;
  defaultPair: ModelEffortPreference;
  recent: ReadonlyMap<string, number>;
  initialSearchInput?: string;
  providers: readonly string[];
}): Promise<PickerResult | undefined> {
  const { ctx } = options;
  const current = ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
  return ctx.ui.custom<PickerResult | undefined>((tui, theme, keybindings, done) => {
    const models = ctx.modelRegistry.getAvailable();
    return new ModelEffortPicker(
      tui,
      theme,
      keybindings,
      current,
      options.defaultPair,
      models,
      ctx.scopedModels,
      options.recent,
      done,
      options.initialSearchInput,
      async (signal) => {
        await ctx.modelRegistry.refresh({ providers: [...options.providers], allowNetwork: false, signal });
        return ctx.modelRegistry.getAvailable();
      },
    );
  });
}

export const _test = { ModelEffortPicker };
