import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelEffortPreference } from "../../extensions/model-control/preferences.js";
import {
  _test,
  applyProfileDefault,
  currentPair,
  ensureProfilePair,
  pairIsAvailable,
  promptWithSignal,
  runProfileSwitchTransaction,
  shouldPreserveSessionPair,
  thinkingFromModelArgument,
} from "../../extensions/model-control/profiles.js";
import { profileAuthPath } from "../../extensions/shared/accounts.js";

const model = (provider: string, id: string, reasoning = true) => ({ provider, id, reasoning }) as Model<Api>;
const codex = model("openai-codex", "personal-model");
const copilot = model("github-copilot", "gpt-5.6-luna");
const google = model("google-vertex", "gemini-3.8-flash");
const claude = model("claude-bridge", "claude-opus-5");
function modelContext(models: Model<Api>[], current: Model<Api> | undefined = codex, thinking = "high") {
  return {
    model: current,
    thinkingLevel: thinking,
    modelRegistry: { getAvailable: () => models } as ExtensionContext["modelRegistry"],
  } as Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;
}

test("model arguments expose an explicit effort suffix", () => {
  expect(thinkingFromModelArgument("openai-codex/gpt-5.6-luna:xhigh")).toBe("xhigh");
  expect(thinkingFromModelArgument("claude-opus-5")).toBeUndefined();
});

test("session lifecycle applies defaults only at the intended boundaries", () => {
  const none = { explicitPair: false, restoresSession: false, inheritedProfile: false };
  expect(shouldPreserveSessionPair("startup", none)).toBeFalse();
  expect(shouldPreserveSessionPair("new", none)).toBeFalse();
  expect(shouldPreserveSessionPair("reload", none)).toBeTrue();
  expect(shouldPreserveSessionPair("resume", none)).toBeTrue();
  expect(shouldPreserveSessionPair("fork", none)).toBeTrue();
  expect(shouldPreserveSessionPair("startup", { ...none, explicitPair: true })).toBeTrue();
  expect(shouldPreserveSessionPair("startup", { ...none, restoresSession: true })).toBeTrue();
  expect(shouldPreserveSessionPair("startup", { ...none, inheritedProfile: true })).toBeTrue();
});

describe("profile switch transaction", () => {
  test("always applies the destination default after login and refresh", async () => {
    const calls: string[] = [];
    const result = await runProfileSwitchTransaction({
      previousProfile: "work",
      targetProfile: "personal",
      prepare: async (profile) => {
        calls.push(`prepare:${profile}`);
      },
      refresh: async (profile) => {
        calls.push(`refresh:${profile}`);
      },
      login: async () => {
        calls.push("login");
      },
      applyDefault: async (profile) => {
        calls.push(`default:${profile}`);
      },
      rollback: async (profile) => {
        calls.push(`rollback:${profile}`);
      },
      restorePair: async () => {
        calls.push("restore-pair");
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["prepare:personal", "refresh:personal", "login", "refresh:personal", "default:personal"]);
  });

  test("rolls back the profile and exact previous pair when destination setup fails", async () => {
    const calls: string[] = [];
    const failure = new Error("target default rejected");
    const result = await runProfileSwitchTransaction({
      previousProfile: "work",
      targetProfile: "personal",
      prepare: async (profile) => {
        calls.push(`prepare:${profile}`);
      },
      refresh: async (profile) => {
        calls.push(`refresh:${profile}`);
      },
      applyDefault: async () => {
        throw failure;
      },
      rollback: async (profile) => {
        calls.push(`rollback:${profile}`);
      },
      restorePair: async () => {
        calls.push("restore-pair");
      },
    });
    expect(result).toEqual({ ok: false, error: failure });
    expect(calls).toEqual(["prepare:personal", "refresh:personal", "rollback:work", "refresh:work", "restore-pair"]);
  });
});

const workDefault: ModelEffortPreference = {
  provider: "claude-bridge",
  model: "claude-opus-5",
  thinking: "medium",
};

test("profile defaults select the exact complete model/effort pair", async () => {
  const ctx = modelContext([codex, claude]);
  const levels: string[] = [];
  const changed: Model<Api>[] = [];
  const result = await applyProfileDefault(
    {
      setModel: async (selected) => {
        changed.push(selected);
        ctx.model = selected;
        return true;
      },
      setThinkingLevel: (level) => {
        levels.push(level);
        ctx.thinkingLevel = level;
      },
    },
    ctx,
    "work",
    workDefault,
  );
  expect(result).toEqual({ pair: workDefault, usedFallback: false });
  expect(changed).toEqual([claude]);
  expect(levels).toEqual(["medium"]);
  expect(currentPair(ctx)).toEqual(workDefault);
});

test("an unavailable default uses a deterministic profile fallback and clamps effort", async () => {
  const noReasoning = model("google-vertex", "gemini-3.8-flash", false);
  const ctx = modelContext([copilot, noReasoning]);
  const result = await applyProfileDefault(
    {
      setModel: async (selected) => {
        ctx.model = selected;
        return true;
      },
      setThinkingLevel: (level) => {
        ctx.thinkingLevel = level;
      },
    },
    ctx,
    "work",
    workDefault,
  );
  // Work provider order makes Copilot the first fallback.
  expect(result.pair).toEqual({ provider: copilot.provider, model: copilot.id, thinking: "medium" });
  expect(result.usedFallback).toBeTrue();

  const offCtx = modelContext([noReasoning], codex);
  const off = await applyProfileDefault(
    {
      setModel: async (selected) => {
        offCtx.model = selected;
        return true;
      },
      setThinkingLevel: (level) => {
        offCtx.thinkingLevel = level;
      },
    },
    offCtx,
    "work",
    workDefault,
  );
  expect(off.pair.thinking).toBe("off");
});

test("preservation accepts only an available complete pair", async () => {
  const ctx = modelContext([google], google, "high");
  expect(pairIsAvailable(ctx, { provider: google.provider, model: google.id, thinking: "high" })).toBeTrue();
  expect(pairIsAvailable(ctx, { provider: google.provider, model: google.id, thinking: "xhigh" })).toBeFalse();
  expect(
    await ensureProfilePair(
      {
        setModel: async () => {
          throw new Error("must preserve current pair");
        },
        setThinkingLevel: () => {
          throw new Error("must preserve current pair");
        },
      },
      ctx,
      "work",
      workDefault,
    ),
  ).toBeUndefined();
});

describe("OAuth interaction", () => {
  test("browser callback aborts a pending manual-code prompt", async () => {
    const controller = new AbortController();
    const dialog = { showManualInput: () => new Promise<string>(() => {}), showPrompt: async () => "typed" };
    const pending = promptWithSignal(dialog, {
      type: "manual_code",
      message: "Paste callback URL",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("Login cancelled");
    expect(await promptWithSignal(dialog, { type: "text", message: "Next step" })).toBe("typed");
  });

  test("an already-cancelled prompt never opens an input dialog", async () => {
    let opened = false;
    const show = async () => {
      opened = true;
      return "";
    };
    await expect(
      promptWithSignal(
        { showManualInput: show, showPrompt: show },
        { type: "text", message: "prompt", signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(opened).toBeFalse();
  });
});

describe("startup profile binding", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  test("swaps the default auth store before the first refresh and is reload-safe", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-startup-binding-"));
    directories.push(root);
    const agent = join(root, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "auth-profiles.json"), JSON.stringify({ activeProfile: "work" }));
    class FakeRuntime {
      refreshCount = 0;
      credentials = {
        store: {
          authPath: join(agent, "auth.json"),
          read: async () => undefined,
          modify: async () => undefined,
          constructor: { create: (path: string) => ({ authPath: path, read: async () => undefined }) },
        },
        overrides: new Map<string, string>(),
      };
      async refresh() {
        this.refreshCount++;
        return { aborted: false, errors: new Map() };
      }
    }
    const prototype = FakeRuntime.prototype as unknown as Parameters<typeof _test.installStartupProfileBinding>[2];
    _test.installStartupProfileBinding(agent, () => "work", prototype);
    const wrapper = prototype.refresh;
    _test.installStartupProfileBinding(agent, () => "work", prototype);
    expect(prototype.refresh).toBe(wrapper);

    const runtime = new FakeRuntime();
    await runtime.refresh();
    expect(runtime.refreshCount).toBe(1);
    expect(runtime.credentials.store.authPath).toBe(profileAuthPath(agent, "work"));
  });
});
