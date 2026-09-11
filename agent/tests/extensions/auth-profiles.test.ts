import { describe, expect, test } from "bun:test";
import { _test, promptWithSignal } from "../../extensions/auth-profiles";

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
