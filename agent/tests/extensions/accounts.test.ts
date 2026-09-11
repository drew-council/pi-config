import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installModelBlacklist } from "../../extensions/model-blacklist/filter.js";
import {
  bindRuntimeProfile,
  chooseProfileModel,
  claudeStatus,
  copilotFromGh,
  type Exec,
  ensureProfileFiles,
  importAccountKey,
  profileAuthPath,
  profileForDirectory,
  readAccountKey,
  readJson,
  runtimeStore,
} from "../../extensions/shared/accounts.js";
import { installProfilePolicy, installScopedModelPolicy } from "../../extensions/shared/profile-policy.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-accounts-"));
  directories.push(root);
  const agent = join(root, "agent");
  mkdirSync(agent);
  return { root, agent };
}
function json(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}
async function runtimeFor(agent: string, profile: "work" | "personal") {
  return ModelRuntime.create({
    authPath: profileAuthPath(agent, profile),
    modelsPath: null,
    modelsStorePath: join(agent, "models-store.json"),
    refreshOnCreate: false,
  });
}
const oauth = {
  type: "oauth",
  access: "fake-access",
  refresh: "fake-refresh",
  expires: 9_999_999_999_999,
  accountId: "test",
};
const execResult = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });

describe("directory-based startup profiles", () => {
  test("selects the home-level profile for roots and nested projects", () => {
    const home = join(tmpdir(), "pi-profile-home");
    expect(profileForDirectory(join(home, "personal"), home)).toBe("personal");
    expect(profileForDirectory(join(home, "personal", "project", "src"), home)).toBe("personal");
    expect(profileForDirectory(join(home, "work"), home)).toBe("work");
    expect(profileForDirectory(join(home, "work", "project", "personal"), home)).toBe("work");
    expect(profileForDirectory(`${home}/personal/../work/project/`, home)).toBe("work");
  });

  test("does not switch for sibling prefixes, nested names elsewhere, or other homes", () => {
    const home = join(tmpdir(), "pi-profile-home");
    for (const cwd of [
      home,
      join(home, "workshop"),
      join(home, "personal-backup"),
      join(home, "repos", "work"),
      join(home, "..", "someone-else", "personal"),
      `${home}/personal/../../outside`,
    ]) {
      expect(profileForDirectory(cwd, home)).toBeUndefined();
    }
  });
});

describe("account initialization", () => {
  test("migrates only designated providers, keeps the original intact and never overwrites a profile", () => {
    const { agent } = fixture();
    const legacy = {
      google: { type: "api_key", key: "work-key" },
      "openai-codex": oauth,
      unrelated: { type: "api_key", key: "leave-alone" },
    };
    json(join(agent, "auth.json"), legacy);
    ensureProfileFiles(agent);
    expect(readJson(profileAuthPath(agent, "work"))).toEqual({ google: legacy.google });
    expect(readJson(profileAuthPath(agent, "personal"))).toEqual({ "openai-codex": oauth });
    json(profileAuthPath(agent, "work"), { google: { type: "api_key", key: "new-key" } });
    ensureProfileFiles(agent);
    expect(readJson(profileAuthPath(agent, "work"))).toEqual({ google: { type: "api_key", key: "new-key" } });
    expect(readJson(join(agent, "auth.json"))).toEqual(legacy);
    expect(statSync(profileAuthPath(agent, "work")).mode & 0o777).toBe(0o600);
    expect(statSync(join(agent, "auth-profiles")).mode & 0o777).toBe(0o700);
  });

  test("seeds both managed keys without losing existing subscription credentials", async () => {
    const { root, agent } = fixture();
    ensureProfileFiles(agent);
    mkdirSync(join(root, "secrets"));
    json(join(root, "secrets/work.json"), { gemini: { apiKey: "gemini-test-key" } });
    json(join(root, "secrets/personal.json"), { openrouter: { apiKey: "router-test-key" } });
    json(profileAuthPath(agent, "personal"), { "openai-codex": oauth });
    const work = await runtimeFor(agent, "work");
    const personal = await runtimeFor(agent, "personal");
    await importAccountKey(work, agent, "google");
    await importAccountKey(personal, agent, "openrouter");
    expect((await work.getAuth("google"))?.auth.apiKey).toBe("gemini-test-key");
    expect((await personal.getAuth("openrouter"))?.auth.apiKey).toBe("router-test-key");
    expect(readJson(profileAuthPath(agent, "personal"))["openai-codex"]).toEqual(oauth);
    expect(Object.keys(readJson(profileAuthPath(agent, "work")))).toEqual(["google"]);
  });

  test("missing, unexpanded, and malformed secret files fail without exposing contents", () => {
    const { root, agent } = fixture();
    expect(() => readAccountKey(agent, "google")).toThrow("install.nu");
    mkdirSync(join(root, "secrets"));
    json(join(root, "secrets/work.json"), { gemini: { apiKey: "{{ op://Employee/item/credential }}" } });
    expect(() => readAccountKey(agent, "google")).toThrow("install.nu");
    writeFileSync(join(root, "secrets/work.json"), '{"gemini": SECRET_MUST_NOT_LEAK');
    try {
      readAccountKey(agent, "google");
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET_MUST_NOT_LEAK");
    }
  });
});

describe("profile isolation using Pi's real credential store", () => {
  test("switching clears runtime keys and leaves an in-flight old-profile write on its original file", async () => {
    const { agent } = fixture();
    ensureProfileFiles(agent);
    json(profileAuthPath(agent, "work"), { google: { type: "api_key", key: "work-old" } });
    json(profileAuthPath(agent, "personal"), { openrouter: { type: "api_key", key: "personal-key" } });
    const runtime = await runtimeFor(agent, "work");
    await runtime.setRuntimeApiKey("openrouter", "runtime-override");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const write = runtimeStore(runtime).modify("google", async () => {
      started();
      await gate;
      return { type: "api_key", key: "work-refreshed" };
    });
    await entered;
    bindRuntimeProfile(runtime, agent, "personal");
    expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("personal-key");
    release();
    await write;
    expect(readJson(profileAuthPath(agent, "work")).google).toEqual({ type: "api_key", key: "work-refreshed" });
    expect(readJson(profileAuthPath(agent, "personal"))).toEqual({
      openrouter: { type: "api_key", key: "personal-key" },
    });
    await runtime.login("openrouter", "api_key", { prompt: async () => "replacement", notify: () => {} });
    expect(readJson(profileAuthPath(agent, "personal")).openrouter).toEqual({ type: "api_key", key: "replacement" });
    expect(readFileSync(profileAuthPath(agent, "work"), "utf8")).not.toContain("replacement");
  });

  test("native availability, auth and login reject other profiles even with ambient credentials; reload stays reversible", async () => {
    const { agent } = fixture();
    ensureProfileFiles(agent);
    json(profileAuthPath(agent, "work"), {
      google: { type: "api_key", key: "work-key" },
      "github-copilot": oauth,
      "openai-codex": oauth,
    });
    const runtime = await runtimeFor(agent, "work");
    await runtime.setRuntimeApiKey("openrouter", "ambient-personal-key");
    let profile: "work" | "personal" = "work";
    installProfilePolicy(runtime, () => profile);
    installModelBlacklist(runtime);
    await runtime.getAvailable();
    const work = runtime.getAvailableSnapshot();
    expect(work.some((m) => m.provider === "google")).toBeTrue();
    expect(work.some((m) => m.provider === "github-copilot" && m.id.startsWith("gpt-"))).toBeTrue();
    expect(work.some((m) => m.provider === "openai-codex" || m.provider === "openrouter")).toBeFalse();
    expect(work.some((m) => m.id === "gpt-4o")).toBeFalse();
    expect(await runtime.getAvailable("openai-codex")).toEqual([]);
    expect(await runtime.checkAuth("openai-codex")).toBeUndefined();
    expect(runtime.hasConfiguredAuth("openrouter")).toBeFalse();
    await expect(runtime.getAuth("openai-codex", { apiKey: "explicit-bypass" })).rejects.toThrow("disabled");
    let prompted = false;
    await expect(
      runtime.login("openrouter", "api_key", {
        prompt: async () => {
          prompted = true;
          return "bad";
        },
        notify: () => {},
      }),
    ).rejects.toThrow("/profile");
    expect(prompted).toBeFalse();
    profile = "personal";
    installProfilePolicy(runtime, () => profile); // hot reload must not stack a second restrictive closure
    const personal = runtime.getAvailableSnapshot();
    expect(personal.some((m) => m.provider === "openai-codex")).toBeTrue();
    expect(personal.every((m) => ["openai-codex", "openrouter"].includes(m.provider))).toBeTrue();
    await expect(runtime.getAuth("google")).rejects.toThrow("disabled");
    profile = "work";
    expect(runtime.getAvailableSnapshot().some((m) => m.provider === "google")).toBeTrue();
  });

  test("a saved personal scope cannot leak into the work picker, explicit selection, or cycling", async () => {
    const { agent } = fixture();
    ensureProfileFiles(agent);
    json(profileAuthPath(agent, "work"), { google: { type: "api_key", key: "work-key" }, "openai-codex": oauth });
    const runtime = await runtimeFor(agent, "work");
    let profile: "work" | "personal" = "work";
    installProfilePolicy(runtime, () => profile);
    await runtime.getAvailable();
    const google = runtime.getModels("google")[0];
    const codex = runtime.getModels("openai-codex")[0];
    if (!google || !codex) throw new Error("Missing built-in test models");
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: agent,
      agentDir: agent,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: agent,
      agentDir: agent,
      modelRuntime: runtime,
      model: google,
      scopedModels: [{ model: codex }],
      noTools: "all",
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(agent),
    });
    installScopedModelPolicy(AgentSession.prototype);
    installScopedModelPolicy(AgentSession.prototype); // reload-safe
    try {
      expect(session.scopedModels).toEqual([]);
      await expect(session.setModel(codex)).rejects.toThrow("No API key");
      const cycled = await session.cycleModel();
      expect(cycled?.model.provider).toBe("google");
      expect(cycled?.isScoped).toBeFalse();
      profile = "personal";
      expect(session.scopedModels.map((entry) => entry.model.provider)).toEqual(["openai-codex"]);
      await session.setModel(codex);
      expect(session.model?.provider).toBe("openai-codex");
    } finally {
      session.dispose();
    }
  });

  test("fallback never selects a provider from the other account, including empty profiles", () => {
    const codex = { provider: "openai-codex", id: "gpt-test" } as Model<Api>;
    const gemini = { provider: "google", id: "gemini-test" } as Model<Api>;
    expect(chooseProfileModel([codex, gemini], "work", codex)).toBe(gemini);
    expect(chooseProfileModel([codex], "work")).toBeUndefined();
    expect(chooseProfileModel([gemini, codex], "personal", codex)).toBe(codex);
  });
});

describe("external accounts", () => {
  test("Claude only checks status and never wraps or invokes login", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (command, args) => {
      calls.push([command, ...args]);
      return execResult('{"loggedIn":false}');
    };
    expect(await claudeStatus(exec)).toEqual({
      loggedIn: false,
      detail: expect.stringContaining("run /login yourself"),
    });
    expect(calls).toEqual([["claude", "auth", "status"]]);
    expect(
      (await claudeStatus(async () => execResult('{"loggedIn":true,"email":"drew@sheerhealth.com"}'))).detail,
    ).toBe("drew@sheerhealth.com");
    expect(
      (
        await claudeStatus(async () => {
          throw new Error("secret error text");
        })
      ).loggedIn,
    ).toBeFalse();
  });

  test("Copilot verifies the pinned GitHub account and fails safely when gh auth is for someone else", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ login: "someone-else" })),
    );
    const calls: string[][] = [];
    try {
      const exec: Exec = async (command, args) => {
        calls.push([command, ...args]);
        return execResult("private-token");
      };
      await expect(copilotFromGh(exec, {} as Provider, new AbortController().signal)).rejects.toThrow(
        "expected drew-council",
      );
      expect(calls).toEqual([["gh", "auth", "token", "--hostname", "github.com", "--user", "drew-council"]]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("Copilot uses native refresh/catalog discovery and redacts exchange failures", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "drew-council" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "drew-council" })));
    const provider = {
      auth: {
        oauth: {
          refresh: async () => {
            throw new Error("private-token upstream body");
          },
        },
      },
    } as unknown as Provider;
    try {
      await expect(
        copilotFromGh(async () => execResult("private-token"), provider, new AbortController().signal),
      ).rejects.toThrow("Use browser login");
      const success = { ...oauth, type: "oauth" as const, availableModelIds: ["gpt-5.6-sol"] };
      if (!provider.auth.oauth) throw new Error("missing test OAuth provider");
      provider.auth.oauth.refresh = async () => success;
      expect(await copilotFromGh(async () => execResult("private-token"), provider, new AbortController().signal)).toBe(
        success,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
