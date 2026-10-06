import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installProfileDefaultsPolicy } from "../../extensions/model-control/preferences.js";
import { installSerialRefresh, installStartupProfileBinding } from "../../extensions/model-control/runtime-adapter.js";
import { type ProfileName, profileAuthPath, runtimeStore } from "../../extensions/shared/accounts.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const providerId = "claude-bridge";
const model = (id: string): Model<Api> => ({
  provider: providerId,
  id,
  name: id,
  api: "anthropic-messages",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1024,
});
const models = [model("fixture-default"), model("fixture-restored")];
const provider: Provider = {
  id: providerId,
  name: "Offline fixture",
  getModels: () => models,
  auth: {
    apiKey: {
      name: "Fixture key",
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
    },
  },
  stream: () => {
    throw new Error("No model requests permitted");
  },
  streamSimple: () => {
    throw new Error("No model requests permitted");
  },
};
// Narrow host seams only for deterministic scheduling and removal of ambient
// built-ins. Catalog composition, credentials, availability publication, service
// construction and startup selection all execute the loaded Pi implementation.
type Host = {
  defaultBuiltins: Map<string, Provider>;
  models: { refresh: ModelRuntime["refresh"] };
  runAvailabilityRefresh: (seq: number, errorSeq: number, signal: AbortSignal) => Promise<void>;
};
async function fixture(profile: ProfileName = "work", legacyCredential = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-startup-refresh-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "auth-profiles"), { recursive: true });
  const credential = { [profile === "work" ? providerId : "openrouter"]: { type: "api_key", key: "fixture-only" } };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(legacyCredential ? credential : {}));
  for (const name of ["work", "personal"] as const) {
    writeFileSync(profileAuthPath(agentDir, name), JSON.stringify(name === profile ? credential : {}));
  }
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const host = runtime as unknown as Host;
  host.defaultBuiltins.clear();
  await runtime.refresh({ allowNetwork: false });
  return { agentDir, runtime, host };
}
const resourceLoaderOptions = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
};

for (const native of [true, false]) {
  for (const serial of [false, true]) {
    test(`${native ? "native" : "config"} extension: ${serial ? "serialized profile startup publishes before selection" : "Pi 1.0.4 still drops an overlapping profile startup pass"}`, async () => {
      const { agentDir, runtime, host } = await fixture();
      const registrationModels = deferred();
      const enteredModels = [deferred(), deferred()];
      const enteredAvailability = [deferred(), deferred()];
      const availability = [deferred(), deferred()];
      const registrationSignal = new AbortController().signal;
      const refreshModels = host.models.refresh.bind(host.models);
      let modelCalls = 0;
      host.models.refresh = async (options) => {
        // Credential bootstrap can complete out of invocation order. Force the
        // registration model pass to start first, then finish last.
        if (options?.signal !== registrationSignal) await enteredModels[0].promise;
        const index = modelCalls++;
        enteredModels[index]?.resolve();
        if (index === 0) await registrationModels.promise;
        return refreshModels(options);
      };
      const runAvailability = host.runAvailabilityRefresh.bind(runtime);
      let availabilityCalls = 0;
      host.runAvailabilityRefresh = async (seq, errorSeq, signal) => {
        const index = availabilityCalls++;
        enteredAvailability[index]?.resolve();
        await availability[index]?.promise;
        return runAvailability(seq, errorSeq, signal);
      };
      // Retain the host-started fire-and-forget registration promise so cleanup
      // never depends on timers or orphaned work after the fixture is removed.
      installStartupProfileBinding(agentDir, () => "work", runtime);
      const refresh = runtime.refresh.bind(runtime);
      const refreshes: Promise<unknown>[] = [];
      runtime.refresh = (options) => {
        const result = refresh({ ...options, signal: refreshes.length === 0 ? registrationSignal : options?.signal });
        refreshes.push(result);
        return result;
      };
      if (serial) installSerialRefresh(runtime);
      const settingsManager = SettingsManager.inMemory();
      installProfileDefaultsPolicy(settingsManager, {
        getProfile: () => "work",
        getPreference: () => ({ provider: providerId, model: models[0].id, thinking: "off" }),
        savePreference: () => {
          throw new Error("Startup must not change defaults");
        },
      });
      const servicesPromise = createAgentSessionServices({
        cwd: agentDir,
        agentDir,
        modelRuntime: runtime,
        settingsManager,
        resourceLoaderOptions: {
          ...resourceLoaderOptions,
          extensionFactories: [
            (pi) => {
              if (native) pi.registerProvider(provider);
              else
                pi.registerProvider(providerId, {
                  api: "anthropic-messages",
                  baseUrl: "https://fixture.invalid",
                  models,
                });
            },
          ],
        },
      });
      try {
        await enteredModels[0].promise;
        expect(runtimeStore(runtime).authPath).toBe(profileAuthPath(agentDir, "work"));
        expect(runtime.getAvailableSnapshot()).toEqual([]);
        if (serial) {
          expect(modelCalls).toBe(1);
          registrationModels.resolve();
          await enteredAvailability[0].promise;
          availability[0].resolve();
          await enteredModels[1].promise;
          await enteredAvailability[1].promise;
          availability[1].resolve();
        } else {
          await enteredModels[1].promise;
          await enteredAvailability[0].promise;
          registrationModels.resolve();
          await enteredAvailability[1].promise;
          // The service's awaited pass is now superseded by registration's pass.
          availability[0].resolve();
        }
        const services = await servicesPromise;
        expect(services.diagnostics).toEqual([]);
        expect(runtime.hasConfiguredAuth(providerId)).toBe(serial);
        const fresh = await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.inMemory(agentDir),
          noTools: "all",
        });
        try {
          expect(fresh.session.model?.id).toBe(serial ? models[0].id : "unknown");
          expect(fresh.modelFallbackMessage === undefined).toBe(serial);
        } finally {
          fresh.session.dispose();
        }
        const manager = SessionManager.inMemory(agentDir);
        manager.appendModelChange(providerId, models[1].id);
        manager.appendMessage({ role: "user", content: "Offline restored history", timestamp: 1 });
        const restored = await createAgentSessionFromServices({ services, sessionManager: manager, noTools: "all" });
        try {
          expect(restored.session.model?.id).toBe(serial ? models[1].id : "unknown");
          expect(restored.modelFallbackMessage === undefined).toBe(serial);
          expect(
            manager.getBranch().some((entry) => entry.type === "model_change" && entry.modelId === models[1].id),
          ).toBeTrue();
        } finally {
          restored.session.dispose();
        }
      } finally {
        registrationModels.resolve();
        for (const gate of availability) gate.resolve();
        await servicesPromise;
        await Promise.all(refreshes);
      }
      expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toEqual(models.map((entry) => entry.id));
    });
  }
}

test("upstream provisional native auth fixes registration when the initial store already held the credential", async () => {
  const { runtime } = await fixture("work", true);
  const refresh = runtime.refresh.bind(runtime);
  const refreshes: Promise<unknown>[] = [];
  runtime.refresh = (options) => {
    const result = refresh(options);
    refreshes.push(result);
    return result;
  };
  runtime.registerNativeProvider(provider);
  // 0.99.2's synchronous provisional update: no availability pass awaited yet.
  expect(runtime.hasConfiguredAuth(providerId)).toBeTrue();
  expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toEqual(models.map((entry) => entry.id));
  await Promise.all(refreshes);
});

test("profile binding preserves already-bound stores and clears legacy runtime overrides", async () => {
  const { agentDir, runtime } = await fixture("personal");
  const internals = runtime as unknown as { credentials: { overrides: Map<string, string> } };
  internals.credentials.overrides.set("openrouter", "legacy-override");
  installStartupProfileBinding(agentDir, () => "personal", runtime);
  installSerialRefresh(runtime);
  await runtime.refresh({ allowNetwork: false });
  expect(runtimeStore(runtime).authPath).toBe(profileAuthPath(agentDir, "personal"));
  expect(internals.credentials.overrides.size).toBe(0);
  const store = runtimeStore(runtime);
  installStartupProfileBinding(agentDir, () => "work", runtime);
  await runtime.refresh({ allowNetwork: false });
  expect(runtimeStore(runtime)).toBe(store);
  expect(await store.read("openrouter")).toEqual({ type: "api_key", key: "fixture-only" });
});

test("serialized refresh forwards cancellation received while queued", async () => {
  const { runtime, host } = await fixture();
  const entered = deferred();
  const release = deferred();
  const refreshModels = host.models.refresh.bind(host.models);
  let calls = 0;
  host.models.refresh = async (options) => {
    if (calls++ === 0) {
      entered.resolve();
      await release.promise;
    }
    return refreshModels(options);
  };
  installSerialRefresh(runtime);
  const pending = runtime.refresh({ allowNetwork: false });
  await entered.promise;
  const controller = new AbortController();
  const cancelled = runtime.refresh({ allowNetwork: false, signal: controller.signal });
  controller.abort();
  release.resolve();
  await pending;
  expect((await cancelled).aborted).toBeTrue();
});
