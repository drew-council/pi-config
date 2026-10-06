import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { runInNewContext } from "node:vm";

const packageRoot = process.env.WEB_ACCESS_PACKAGE_ROOT ?? `${import.meta.dir}/../../npm/node_modules/pi-web-access`;
const installed = existsSync(`${packageRoot}/package.json`);
const runtimeTest = installed ? test : test.skip;

function harness() {
  const manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./dist"]);
  assert.match(readFileSync(`${packageRoot}/gemini-api.ts`, "utf8"), /DEFAULT_MODEL = "gemini-3\.8-flash"/);
  for (const source of ["video-extract.ts", "youtube-extract.ts"]) {
    assert.match(readFileSync(`${packageRoot}/${source}`, "utf8"), /preferredModel: "gemini-3\.8-flash"/);
  }
  const bundle = readFileSync(`${packageRoot}/dist/index.js`, "utf8");
  assert.match(bundle, /DEFAULT_MODEL = "gemini-3\.8-flash"/);
  assert.match(bundle, /defaults = \{ enabled: true, preferredModel: "gemini-3\.8-flash" \}/);
  assert.match(bundle, /VIDEO_CONFIG_DEFAULTS = \{\s+enabled: true,\s+preferredModel: "gemini-3\.8-flash"/);
  // Execute the actual loaded artifact's video functions, replacing only IO boundaries.
  const video = bundle.slice(bundle.indexOf("function videoErrorMessage("), bundle.indexOf("var init_video_extract ="));
  assert.ok(video.length > 0);
  const models: string[] = [];
  const deleted: string[] = [];
  let uploads = 0;
  let webCalls = 0;
  const context = {
    Error,
    basename4: basename,
    activityMonitor: { logStart: () => 1, logComplete: () => {}, logError: () => {} },
    canAttachImages: () => false,
    getApiKey: async () => "test-key",
    isGeminiWebAvailable: async () => "test-cookies",
    queryWithCookies: async (): Promise<string> => {
      webCalls++;
      throw new Error("web unavailable");
    },
    queryGeminiApiWithVideo: async (_prompt: string, _uri: string, options: { model: string }): Promise<string> => {
      models.push(options.model);
      throw new Error("503\n high demand");
    },
    loadVideoConfig: () => ({ preferredModel: "gemini-3.8-flash" }),
    uploadToFilesApi: async () => {
      uploads++;
      return { name: "files/test", uri: "test-uri" };
    },
    pollFileState: async () => {},
    deleteGeminiFile: (name: string) => deleted.push(name),
    extractVideoTitle: () => "Test video",
  };
  const configure = [
    "loadVideoConfig",
    "uploadToFilesApi",
    "pollFileState",
    "deleteGeminiFile",
    "extractVideoTitle",
    "queryGeminiApiWithVideo",
    "queryWithCookies",
    "getApiKey",
    "isGeminiWebAvailable",
  ];
  const loaded = runInNewContext(
    `(function() { ${video}
return ({ extractVideo, configure(o) { ${configure.map((name) => `${name} = o.${name};`).join(" ")} CONFIG_PATH44 = "/test/config.json"; } }); })()`,
    context,
  );
  const runtime = {
    extractVideo(...args: unknown[]) {
      loaded.configure(context);
      return loaded.extractVideo(...args);
    },
  };
  return { runtime, context, models, deleted, uploads: () => uploads, webCalls: () => webCalls };
}

const info = { absolutePath: "/test/video.mp4", mimeType: "video/mp4", withinUploadLimit: true };

runtimeTest(
  "pi-web-access loaded dist uses stable defaults and bounded deduplicated fallback with one upload",
  async () => {
    const h = harness();
    const result = await h.runtime.extractVideo(info, undefined, { model: " custom-model " });
    assert.deepEqual(h.models, ["custom-model", "gemini-2.5-flash", "gemini-flash-latest"]);
    assert.equal(h.uploads(), 1);
    assert.deepEqual(h.deleted, ["files/test"]);
    assert.equal(h.webCalls(), 1);
    assert.match(result.error, /Gemini API \(custom-model\): 503 high demand/);
    assert.match(result.error, /Gemini Web: web unavailable/);
    assert.equal(result.content, "");
    const defaults = harness();
    await defaults.runtime.extractVideo(info);
    assert.deepEqual(defaults.models, ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-flash-latest"]);
  },
);

runtimeTest("pi-web-access loaded dist stops after fallback success and retains web success", async () => {
  const h = harness();
  h.context.queryGeminiApiWithVideo = async (_prompt, _uri, options) => {
    h.models.push(options.model);
    if (options.model === "custom") throw new Error("unavailable");
    return "video content";
  };
  const result = await h.runtime.extractVideo(info, undefined, { model: "custom" });
  assert.equal(result.content, "video content");
  assert.deepEqual(h.models, ["custom", "gemini-2.5-flash"]);
  assert.equal(h.webCalls(), 0);
  assert.deepEqual(h.deleted, ["files/test"]);
  const web = harness();
  web.context.getApiKey = async () => null;
  web.context.queryWithCookies = async () => "web content";
  assert.equal((await web.runtime.extractVideo(info)).content, "web content");
  assert.equal(web.uploads(), 0);
});

runtimeTest("pi-web-access loaded dist preserves cancellation, parse errors, and cleanup", async () => {
  const h = harness();
  const controller = new AbortController();
  h.context.queryGeminiApiWithVideo = async (_prompt, _uri, options) => {
    h.models.push(options.model);
    controller.abort();
    throw new Error("cancelled");
  };
  assert.equal(await h.runtime.extractVideo(info, controller.signal), null);
  assert.deepEqual(h.models, ["gemini-3.8-flash"]);
  assert.deepEqual(h.deleted, ["files/test"]);
  assert.equal(h.webCalls(), 0);
  const parse = harness();
  parse.context.queryGeminiApiWithVideo = async () => {
    throw new Error("Failed to parse /test/config.json");
  };
  await assert.rejects(parse.runtime.extractVideo(info), /Failed to parse/);
  assert.deepEqual(parse.deleted, ["files/test"]);
});

runtimeTest(
  "pi-web-access loaded dist reports missing access and upload failures without unbounded retries",
  async () => {
    const missing = harness();
    missing.context.getApiKey = async () => null;
    missing.context.isGeminiWebAvailable = async () => null;
    assert.match((await missing.runtime.extractVideo(info)).error, /Video analysis requires Gemini access/);
    assert.equal(missing.uploads(), 0);
    const upload = harness();
    upload.context.uploadToFilesApi = async () => {
      throw new Error("upload failed");
    };
    assert.match((await upload.runtime.extractVideo(info)).error, /Gemini API: upload failed/);
    assert.deepEqual(upload.models, []);
    assert.deepEqual(upload.deleted, []);
  },
);

test("web-access configured video and YouTube preferences match the Gemini 3.8 runtime default", () => {
  const config = JSON.parse(readFileSync(`${import.meta.dir}/../../../web-search.json`, "utf8"));
  assert.equal(config.video.preferredModel, "gemini-3.8-flash");
  assert.equal(config.youtube.preferredModel, "gemini-3.8-flash");
});
