import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { _test, ensureProfileModel, promptWithSignal } from "../../extensions/auth-profiles";

const codex = { provider: "openai-codex", id: "personal-model" } as Model<Api>;
const copilot = { provider: "github-copilot", id: "work-model" } as Model<Api>;
const google = { provider: "google", id: "work-fallback" } as Model<Api>;
function modelContext(models: Model<Api>[]) {
  return { model: codex, modelRegistry: { getAvailable: () => models } as ExtensionContext["modelRegistry"] };
}

test("switching away from Codex selects a work model and handles rejected provider auth", async () => {
  const ctx = modelContext([codex, copilot, google]);
  const attempted: string[] = [];
  await ensureProfileModel(
    {
      setModel: async (model) => {
        attempted.push(model.provider);
        if (model.provider === "github-copilot") return false;
        ctx.model = model;
        return true;
      },
    },
    ctx,
    "work",
  );
  expect(ctx.model).toBe(google);
  expect(attempted).toEqual(["github-copilot", "google"]);
});

test("failed model selection cannot be reported as a successful profile switch", async () => {
  await expect(ensureProfileModel({ setModel: async () => false }, modelContext([copilot]), "work")).rejects.toThrow(
    "No usable work model",
  );
  await expect(
    ensureProfileModel(
      {
        setModel: async () => {
          throw new Error("must not select Codex");
        },
      },
      modelContext([codex]),
      "work",
    ),
  ).rejects.toThrow("No usable work model");
});

describe("OAuth interaction", () => {
  test("browser callback aborts a pending manual-code prompt without waiting for terminal input", async () => {
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

describe("auth profile refresh", () => {
  test("runs provider-scoped offline refresh without returning work to startup", async () => {
    let resolveOptions: (options: unknown) => void = () => {};
    const options = new Promise<unknown>((resolve) => {
      resolveOptions = resolve;
    });
    const registry = {
      refresh(received: unknown) {
        resolveOptions(received);
        return Promise.resolve({ aborted: false, errors: new Map() });
      },
    };

    expect(_test.refreshRegistryInBackground(registry, ["openai-codex"], async () => {})).toBeUndefined();
    expect(await options).toMatchObject({
      allowNetwork: false,
      providers: ["openai-codex"],
      signal: expect.any(AbortSignal),
    });
  });

  test("aborts a background refresh that exceeds its deadline", async () => {
    let resolveAborted: (aborted: boolean) => void = () => {};
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    const registry = {
      refresh(options: { signal: AbortSignal }) {
        return new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              resolveAborted(options.signal.aborted);
              resolve({ aborted: true, errors: new Map() });
            },
            { once: true },
          );
        });
      },
    };

    expect(_test.refreshRegistryInBackground(registry, [], async () => {}, 1)).toBeUndefined();
    expect(await aborted).toBeTrue();
  });
});
