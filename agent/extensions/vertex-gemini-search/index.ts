/**
 * Vertex Gemini Search extension
 *
 * Vendored from https://github.com/nilskluewer/pi-vertex-gemini-search (MIT)
 * and adapted to this repository's Vertex AI setup.
 *
 * Registers two tools the model can call autonomously for live/fresh info:
 *   - web_search   : quick verification / fact check (short answer)
 *   - web_research : complex topics (longer, more detailed answer)
 *
 * Both use Vertex AI Gemini with Google Search grounding. The search context
 * stays inside the tool result, keeping the main conversation lean.
 *
 * Source URLs returned by Gemini are vertexaisearch.cloud.google.com redirect
 * links. They are resolved to their pure destination URLs (via the 302
 * `location` header, no body download) so only clean links enter your context.
 *
 * Requests always go to Sheer Health's pinned Vertex project (ZDR/BAA), in
 * every profile, authenticated with the same gcloud Application Default
 * Credentials as the `google-vertex` model provider. Ambient env vars cannot
 * redirect them.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { VERTEX_ENV, vertexAdcPath } from "../shared/accounts.js";

const VERTEX_PROJECT_ID = VERTEX_ENV.GOOGLE_CLOUD_PROJECT;
const VERTEX_REGION = VERTEX_ENV.GOOGLE_CLOUD_LOCATION;
const VERTEX_PROVIDER = "google-vertex";
// The model blacklist in model-control/policy.ts only permits Gemini 3.8+.
const GEMINI_MODEL_SHORT = "gemini-3.8-flash";
const GEMINI_MODEL_LONG = "gemini-3.8-flash";
const GEMINI_ENDPOINT = (model: string) => {
  const host = VERTEX_REGION === "global" ? "aiplatform.googleapis.com" : `${VERTEX_REGION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
};
const MAX_SOURCES = 6;
const SEARCH_GROUNDING_USD_PER_1000 = 14;
const FLEX_TOKEN_DISCOUNT = 0.5;
type PricingPreference = "flex" | "standard";
// Flex requests hang until timeout on Sheer Health's project, and grounding
// dominates the cost anyway, so Flex is opt-in via /search-pricing.
let pricingPreference: PricingPreference = "standard";
let flexUnavailableForSession = false;
// Transient statuses Google recommends retrying with exponential backoff.
// 503 in particular signals temporary overload / high demand on the model.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3; // total attempts per tier = MAX_RETRIES + 1
const MAX_BACKOFF_MS = 16_000;
const MAX_RETRY_AFTER_MS = 60_000;

const SYSTEM_INSTRUCTION = `You are a web research assistant with live internet access via two tools: google_search (web search) and url_context (fetch & read specific URLs the user gives you).
RULES:
- ALWAYS ground your answer using these tools. Never answer from memory alone — search the web and/or read any URLs provided.
- If the input includes URLs, READ them with url_context before answering.
- Treat the input as context-rich: it may contain background, constraints, prior conclusions, or a request for a second opinion. Use all of it.
- State facts directly. Include version numbers, dates, and names when relevant.
- When asked for an opinion or analysis, reason from grounded evidence and clearly separate fact from judgment.
- Do not add filler, disclaimers, or conversational preamble.
- If results are uncertain, missing, or conflicting, say so briefly.
- Cite which sources support key claims where useful.`;

const ADC_LOGIN_HINT = "Run `gcloud auth application-default login` as your Sheer Health account.";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
let cachedToken: { token: string; expiresAt: number; source: string } | undefined;

/**
 * Mints an access token from the gcloud ADC file. `authorized_user` files (from
 * `gcloud auth application-default login`) are exchanged directly; any other
 * credential type is delegated to gcloud. Tokens are cached until shortly
 * before they expire.
 */
async function resolveAccessToken(signal: AbortSignal): Promise<string> {
  const path = vertexAdcPath();
  if (cachedToken && cachedToken.source === path && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  let adc: { type?: string; client_id?: string; client_secret?: string; refresh_token?: string };
  try {
    adc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`No readable gcloud Application Default Credentials at ${path}. ${ADC_LOGIN_HINT}`);
  }

  if (adc.type === "authorized_user" && adc.client_id && adc.client_secret && adc.refresh_token) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: adc.refresh_token,
      }),
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      // Never echo the response body: it can contain credential details.
      throw new Error(`gcloud ADC token refresh failed (${response.status}). ${ADC_LOGIN_HINT}`);
    }
    cachedToken = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_REFRESH_MARGIN_MS,
      source: path,
    };
    return body.access_token;
  }

  try {
    const { stdout } = await promisify(execFile)("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf-8",
      env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: path },
      signal,
      timeout: 30_000,
    });
    const token = stdout.trim();
    if (!token) throw new Error("empty token");
    // gcloud does not report the expiry; its tokens last an hour.
    cachedToken = { token, expiresAt: Date.now() + 3_000_000, source: path };
    return token;
  } catch {
    throw new Error(`Could not get a Vertex AI access token from gcloud ADC (${path}). ${ADC_LOGIN_HINT}`);
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  error?: { message?: string };
}

interface SourceLink {
  index: number;
  host: string;
  url: string;
}

interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueries: number;
  tokenUsd: number;
  groundingUsd: number;
  totalUsd: number;
  pricingNote: string;
}

/**
 * Resolve a vertexaisearch redirect URL to its pure destination by reading the
 * 302 `location` header. Falls back to the original URL on any failure.
 */
async function resolveUrl(url: string, signal: AbortSignal): Promise<string> {
  if (!url.includes("vertexaisearch.cloud.google.com")) return url;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
    });
    const loc = res.headers.get("location");
    if (loc) return loc;
  } catch {
    // ignore — return original
  }
  return url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Token rates (USD per million) come from the `google-vertex` model catalog. */
function modelPricingUsdPerMillion(ctx: ExtensionToolContext, model: string): { input: number; output: number } {
  const cost = ctx.modelRegistry.find(VERTEX_PROVIDER, model)?.cost;
  return { input: cost?.input ?? 0, output: cost?.output ?? 0 };
}

function money(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}

function estimateCost(params: {
  model: string;
  pricing: { input: number; output: number };
  serviceTier: "flex" | "standard";
  usage?: GeminiResponse["usageMetadata"];
  searchQueries: number;
}): CostEstimate {
  const inputTokens = params.usage?.promptTokenCount ?? 0;
  const outputTokens = (params.usage?.candidatesTokenCount ?? 0) + (params.usage?.thoughtsTokenCount ?? 0);
  const totalTokens = params.usage?.totalTokenCount ?? inputTokens + outputTokens;
  const standardTokenUsd = (inputTokens * params.pricing.input + outputTokens * params.pricing.output) / 1_000_000;
  const tokenDiscount = params.serviceTier === "flex" ? FLEX_TOKEN_DISCOUNT : 1;
  const tokenUsd = standardTokenUsd * tokenDiscount;
  const groundingUsd = (params.searchQueries * SEARCH_GROUNDING_USD_PER_1000) / 1000;
  const totalUsd = tokenUsd + groundingUsd;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    searchQueries: params.searchQueries,
    tokenUsd,
    groundingUsd,
    totalUsd,
    pricingNote:
      `Google Search grounding ${params.searchQueries} × $${SEARCH_GROUNDING_USD_PER_1000}/1k queries = ${money(groundingUsd)}; ` +
      `tokens ${inputTokens} in / ${outputTokens} out at ${params.model} rates` +
      (params.serviceTier === "flex"
        ? ` with Flex ${Math.round((1 - FLEX_TOKEN_DISCOUNT) * 100)}% token discount`
        : " at standard tier") +
      ` = ${money(tokenUsd)}.`,
  };
}

function summaryLine(params: {
  model: string;
  region: string;
  cost: CostEstimate;
  sourceCount: number;
  serviceTier: "flex" | "standard";
}): string {
  const sourceLabel = `${params.sourceCount} source${params.sourceCount === 1 ? "" : "s"}`;
  const pricingLabel = params.serviceTier === "flex" ? "flex pricing" : "standard pricing";
  return (
    `◆ Gemini Search [` +
    `${params.model}, ${params.region}, ` +
    `${money(params.cost.totalUsd)}, ` +
    `${sourceLabel}, ${pricingLabel}` +
    `]`
  );
}

function ansi(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function linkifyUrls(line: string): string {
  return line.replace(/https?:\/\/[^\s)]+/g, (raw) => {
    const trailing = raw.match(/[.,;:]$/)?.[0] ?? "";
    const url = trailing ? raw.slice(0, -1) : raw;
    return `${osc8(url, ansi("1;4;96", url))}${trailing}`;
  });
}

function brutalistLine(line: string): string {
  if (line.startsWith("◆ Gemini Search [")) {
    const open = line.indexOf("[");
    const meta = open >= 0 ? line.slice(open) : "";
    return `${ansi("1;30;103", " ◆ GEMINI SEARCH ")} ${ansi("1;96", meta)}`;
  }

  if (line === "Sources:") {
    return ansi("1;30;106", " SOURCES ");
  }

  const sourceMatch = line.match(/^(\d+)\.\s+(.+?)\s+[—-]\s+(https?:\/\/\S+)$/);
  if (sourceMatch) {
    const [, index, host, url] = sourceMatch;
    return [ansi("1;33", `${index}.`), ansi("1;95", host), ansi("90", "—"), osc8(url, ansi("1;4;96", url))].join(" ");
  }

  if (line.trim() === "") return line;

  return ansi("97", linkifyUrls(line));
}

function renderSearchResult(result: { content?: Array<{ type?: string; text?: string }> }) {
  const text =
    result.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? "";

  return new Text(text.split("\n").map(brutalistLine).join("\n"), 0, 0);
}

interface RunOptions {
  query: string;
  detail: "short" | "long";
}

async function runSearch(
  { query, detail }: RunOptions,
  signal: AbortSignal,
  ctx: ExtensionToolContext,
): Promise<{
  text: string;
  model: string;
  endpoint: string;
  serviceTier: "flex" | "standard";
  sources: SourceLink[];
  sourceCount: number;
  groundingQueries: string[];
  cost: CostEstimate;
}> {
  const accessToken = await resolveAccessToken(signal);

  const instruction =
    detail === "long"
      ? `${SYSTEM_INSTRUCTION}\nThis is a COMPLEX research query. Provide a thorough, well-structured answer covering the key facets of the topic. Organize with short sections or bullet points where helpful. Aim for completeness over brevity.`
      : `${SYSTEM_INSTRUCTION}\nThis is a QUICK verification query. Answer as concisely as possible — ideally one to three sentences. Only include the essential fact(s) needed to verify or check.`;

  const model = detail === "long" ? GEMINI_MODEL_LONG : GEMINI_MODEL_SHORT;
  const flexTimeout = detail === "long" ? 160_000 : 60_000;
  const standardTimeout = detail === "long" ? 260_000 : 60_000;

  const buildBody = (serviceTier: "flex" | "standard") => ({
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: "user", parts: [{ text: query }] }],
    tools: [{ google_search: {} }, { url_context: {} }],
    labels: {
      app: "pi-vertex-gemini-search",
      module: "vertex-ai",
      tier: serviceTier,
    },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: detail === "long" ? 12000 : 2000,
    },
  });

  const doFetch = async (serviceTier: "flex" | "standard", timeoutMs: number): Promise<Response> => {
    // Combine the user's abort signal with our timeout.
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (serviceTier === "flex") {
      headers["X-Vertex-AI-LLM-Shared-Request-Type"] = "flex";
      headers["X-Vertex-AI-LLM-Request-Type"] = "shared";
    }
    return fetch(GEMINI_ENDPOINT(model), {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(serviceTier)),
      signal: combined,
    });
  };

  /**
   * Sleep that rejects early if the caller aborts. Keeps retries responsive to
   * cancellation.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /**
   * Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds.
   */
  const parseRetryAfter = (header: string | null): number | undefined => {
    if (!header) return undefined;
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return undefined;
  };

  /**
   * Exponential backoff with jitter (Google's recommended strategy for 503).
   * Honors `Retry-After` when the server provides it.
   */
  const backoffDelay = (attempt: number, retryAfterMs?: number): number => {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    return base + Math.random() * 500; // jitter to avoid thundering herd
  };

  /**
   * Fetch with bounded retries on transient errors (429/5xx) and network
   * failures. Returns the last response if retries are exhausted (so the
   * caller can still inspect status / fall back to another tier).
   */
  const fetchWithRetry = async (serviceTier: "flex" | "standard", timeoutMs: number): Promise<Response> => {
    let lastResponse: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const res = await doFetch(serviceTier, timeoutMs);
        if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
        lastResponse = res;
        lastError = undefined;
      } catch (err) {
        if (signal.aborted) throw err; // user cancelled
        // A Flex timeout means queued capacity; fall back to standard at once.
        if (serviceTier === "flex") throw err;
        lastError = err;
        lastResponse = undefined;
      }
      if (attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(lastResponse?.headers.get("retry-after") ?? null);
        await sleep(backoffDelay(attempt, retryAfterMs));
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError;
  };

  // 1) Try Flex first (50% cheaper, but slow / sheddable) with retries on
  //    transient errors.
  // 2) On timeout / network error OR a retryable status that exhausted retries,
  //    fall back to the standard tier (longer timeout) and retry there too.
  let response: Response;
  let usedServiceTier: "flex" | "standard" =
    pricingPreference === "standard" || flexUnavailableForSession ? "standard" : "flex";
  if (pricingPreference === "standard" || flexUnavailableForSession) {
    response = await fetchWithRetry("standard", standardTimeout);
  } else {
    try {
      response = await fetchWithRetry("flex", flexTimeout);
      usedServiceTier = "flex";
    } catch (err) {
      if (signal.aborted) throw err; // user cancelled - don't retry
      response = await fetchWithRetry("standard", standardTimeout);
      usedServiceTier = "standard";
    }
  }

  // Flex can still return a retryable error after exhausting its retries
  // (common — the Flex tier sheds load aggressively). Give standard a turn.
  if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
    response = await fetchWithRetry("standard", standardTimeout);
    usedServiceTier = "standard";
  }

  // Some Vertex projects/regions don't support Flex. In that case Vertex returns
  // a non-retryable 400, but the same request is valid at the standard tier.
  if (!response.ok && usedServiceTier === "flex" && response.status === 400) {
    flexUnavailableForSession = true;
    response = await fetchWithRetry("standard", standardTimeout);
    usedServiceTier = "standard";
  }

  if (response.status === 401) {
    // A revoked or rotated login: drop the cached token so the next call refreshes it.
    cachedToken = undefined;
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex AI Gemini API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Vertex AI Gemini API error: ${data.error.message ?? "unknown"}`);
  }

  const candidate = data.candidates?.[0];
  const answer =
    candidate?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("\n")
      .trim() || "(no answer returned)";

  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const rawUrls = chunks
    .map((c) => c.web?.uri)
    .filter((u): u is string => !!u)
    .slice(0, MAX_SOURCES);

  // Resolve redirect URLs to pure links in parallel (best-effort, bounded).
  const resolved = await Promise.all(rawUrls.map((u) => resolveUrl(u, signal)));

  const seen = new Set<string>();
  const sources: SourceLink[] = [];
  for (const u of resolved) {
    if (seen.has(u)) continue;
    seen.add(u);
    sources.push({
      index: sources.length + 1,
      host: hostOf(u),
      url: u,
    });
  }

  const groundingQueries = candidate?.groundingMetadata?.webSearchQueries ?? [];
  const searchQueries = Math.max(groundingQueries.length, sources.length > 0 ? 1 : 0);
  const cost = estimateCost({
    model,
    pricing: modelPricingUsdPerMillion(ctx, model),
    serviceTier: usedServiceTier,
    usage: data.usageMetadata,
    searchQueries,
  });
  const provenance = summaryLine({
    model,
    region: VERTEX_REGION,
    cost,
    sourceCount: sources.length,
    serviceTier: usedServiceTier,
  });
  const sourceLines = sources.map((s) => `${s.index}. ${s.host ? `${s.host} — ` : ""}${s.url}`);
  const text =
    sourceLines.length > 0
      ? `${provenance}\n\n${answer}\n\nSources:\n${sourceLines.join("\n")}`
      : `${provenance}\n\n${answer}`;

  return {
    text,
    model,
    endpoint: GEMINI_ENDPOINT(model),
    serviceTier: usedServiceTier,
    sources,
    sourceCount: sources.length,
    groundingQueries,
    cost,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
    isError: true,
  };
}

async function executeSearch(
  query: string,
  detail: "short" | "long",
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
) {
  try {
    const result = await runSearch({ query, detail }, signal ?? new AbortController().signal, ctx);
    return {
      content: [{ type: "text" as const, text: result.text }],
      details: {
        model: result.model,
        endpoint: result.endpoint,
        region: VERTEX_REGION,
        serviceTier: result.serviceTier,
        depth: detail,
        sourceCount: result.sourceCount,
        sources: result.sources,
        groundingQueries: result.groundingQueries,
        cost: result.cost,
      },
    };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("search-pricing", {
    description: "Show or set the Vertex Gemini Search pricing tier: flex or standard.",
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "flex") {
        pricingPreference = "flex";
        flexUnavailableForSession = false;
        ctx.ui.notify("Gemini Search will prefer Flex pricing and fall back to standard if needed.", "info");
        return;
      }
      if (choice === "standard") {
        pricingPreference = "standard";
        ctx.ui.notify("Gemini Search will use standard pricing.", "info");
        return;
      }
      if (choice === "" || choice === "status") {
        const availability =
          pricingPreference === "flex" && flexUnavailableForSession
            ? "Flex is unavailable for this session; searches currently use standard."
            : `Gemini Search pricing preference: ${pricingPreference}.`;
        ctx.ui.notify(`${availability} Use /search-pricing flex or /search-pricing standard.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /search-pricing [flex|standard|status]", "error");
    },
  });

  // Quick verification / fact check.
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Quick fact-check or verification via a companion model WITH live web access. " +
      "It searches the web + reads any URLs you pass, then returns ONLY a concise synthesized answer + source URLs — no raw page dumps, no irrelevant content noise, so your context stays lean. " +
      "Input is context-rich: include background, the claim to verify, URLs to cross-check; more context = better answer. " +
      "Use for version numbers, dates, single facts, or a quick second opinion. For complex topics use web_research.",
    parameters: Type.Object({
      query: Type.String({
        description: "The specific fact or question to verify on the web.",
      }),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => executeSearch(params.query, "short", signal, ctx),
    renderResult: renderSearchResult,
  });

  // In-depth research on a complex topic.
  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "In-depth research, comparison, or grounded second opinion via a companion model WITH live web access. " +
      "It searches the web + reads any URLs you pass, then returns ONLY a synthesized, structured answer + source URLs — no raw page dumps, no irrelevant content noise, so your context stays lean. " +
      "Input is context-rich: include background, constraints, prior conclusions, docs URLs to read; more context = better answer. " +
      "Use for multi-faceted topics, how-tos, architecture opinions. For quick checks use web_search.",
    parameters: Type.Object({
      query: Type.String({
        description: "The complex topic or research question to investigate on the web.",
      }),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => executeSearch(params.query, "long", signal, ctx),
    renderResult: renderSearchResult,
  });
}
