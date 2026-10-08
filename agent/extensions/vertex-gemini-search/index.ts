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
 * Requests go through Pi's `google-vertex` provider with the active profile's
 * stored credential, so they use the same Sheer Health project (ZDR/BAA) and
 * gcloud Application Default Credentials as Vertex chat models. The extension
 * refuses to run unless that credential is pinned to the project, so ambient
 * GOOGLE_CLOUD_* env vars cannot redirect searches.
 */

import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { VERTEX_ENV } from "../shared/accounts.js";

const VERTEX_PROVIDER = "google-vertex";
// The model blacklist in model-control/policy.ts only permits Gemini 3.8+.
const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_SOURCES = 6;
const SEARCH_GROUNDING_USD_PER_1000 = 14;
const FLEX_TOKEN_DISCOUNT = 0.5;
const FLEX_HEADERS = { "X-Vertex-AI-LLM-Shared-Request-Type": "flex", "X-Vertex-AI-LLM-Request-Type": "shared" };
const COLLAPSED_ANSWER_LINES = 4;
type ServiceTier = "flex" | "standard";
type Depth = "short" | "long";
// Flex has hung until timeout on Sheer Health's project, and grounding
// dominates the cost anyway, so Flex is opt-in via /search-pricing.
let pricingPreference: ServiceTier = "standard";
let flexUnavailableForSession = false;

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

const DEPTHS: Record<Depth, { instruction: string; maxTokens: number; timeoutMs: Record<ServiceTier, number> }> = {
  short: {
    instruction: `${SYSTEM_INSTRUCTION}\nThis is a QUICK verification query. Answer as concisely as possible — ideally one to three sentences. Only include the essential fact(s) needed to verify or check.`,
    maxTokens: 2000,
    timeoutMs: { flex: 60_000, standard: 60_000 },
  },
  long: {
    instruction: `${SYSTEM_INSTRUCTION}\nThis is a COMPLEX research query. Provide a thorough, well-structured answer covering the key facets of the topic. Organize with short sections or bullet points where helpful. Aim for completeness over brevity.`,
    maxTokens: 12000,
    timeoutMs: { flex: 160_000, standard: 260_000 },
  },
};

const SearchOutput = Type.Object({
  answer: Type.String(),
  sources: Type.Array(Type.Object({ host: Type.String(), url: Type.String() })),
  searchQueries: Type.Array(Type.String()),
  model: Type.String(),
  location: Type.String(),
  serviceTier: Type.Union([Type.Literal("flex"), Type.Literal("standard")]),
  costUsd: Type.Number({ description: "Estimated token plus Google Search grounding cost" }),
});
type SearchOutput = Static<typeof SearchOutput>;

interface Grounding {
  queries: Set<string>;
  urls: Set<string>;
}

interface GroundingChunk {
  candidates?: Array<{
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string } }>;
    };
  }>;
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

function money(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}

/**
 * Resolves the Vertex model and checks that the active profile's credential
 * is pinned to Sheer Health's project. Without the pin, the provider would
 * fall back to ambient GOOGLE_CLOUD_* env vars or a stored API key.
 */
async function resolveVertex(ctx: ExtensionToolContext): Promise<{ model: Model<Api>; location: string }> {
  const model = ctx.modelRegistry.find(VERTEX_PROVIDER, GEMINI_MODEL);
  if (!model) throw new Error(`${VERTEX_PROVIDER}/${GEMINI_MODEL} is not in Pi's model catalog.`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || auth.apiKey || auth.env?.GOOGLE_CLOUD_PROJECT !== VERTEX_ENV.GOOGLE_CLOUD_PROJECT) {
    throw new Error(
      "Google Vertex AI is not pinned to Sheer Health's project in this profile. Run /log-me-in and choose Google Vertex AI.",
    );
  }
  if (!auth.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "No gcloud Application Default Credentials. Run `gcloud auth application-default login` as your Sheer Health account, then /log-me-in to recheck Google Vertex AI.",
    );
  }
  return { model, location: auth.env.GOOGLE_CLOUD_LOCATION ?? VERTEX_ENV.GOOGLE_CLOUD_LOCATION };
}

/** Adds Google Search and URL context grounding to the provider's assembled request. */
function withGrounding(payload: unknown, serviceTier: ServiceTier): unknown {
  const params = payload as { config?: Record<string, unknown> };
  return {
    ...params,
    config: {
      ...params.config,
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      labels: { app: "pi-vertex-gemini-search", module: "vertex-ai", tier: serviceTier },
    },
  };
}

function collectGrounding(chunk: unknown, grounding: Grounding): void {
  const metadata = (chunk as GroundingChunk).candidates?.[0]?.groundingMetadata;
  for (const query of metadata?.webSearchQueries ?? []) grounding.queries.add(query);
  for (const source of metadata?.groundingChunks ?? []) if (source.web?.uri) grounding.urls.add(source.web.uri);
}

/**
 * Tool-result usage counts toward the session cost. Pi prices tokens at the
 * catalog's standard rates, so Flex gets its discount here, and the Google
 * Search grounding fee, which has no token category, is included in `total`.
 */
function searchUsage(usage: Usage, serviceTier: ServiceTier, searchQueries: number): Usage {
  const discount = serviceTier === "flex" ? FLEX_TOKEN_DISCOUNT : 1;
  const grounding = (searchQueries * SEARCH_GROUNDING_USD_PER_1000) / 1000;
  return {
    ...usage,
    cost: {
      input: usage.cost.input * discount,
      output: usage.cost.output * discount,
      cacheRead: usage.cost.cacheRead * discount,
      cacheWrite: usage.cost.cacheWrite * discount,
      total: usage.cost.total * discount + grounding,
    },
  };
}

async function requestTier(
  ctx: ExtensionToolContext,
  model: Model<Api>,
  depth: Depth,
  query: string,
  serviceTier: ServiceTier,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<{ message: AssistantMessage; grounding: Grounding }> {
  const grounding: Grounding = { queries: new Set(), urls: new Set() };
  const { instruction, maxTokens, timeoutMs } = DEPTHS[depth];
  const stream = ctx.modelRegistry.streamSimple(
    model,
    { systemPrompt: instruction, messages: [{ role: "user", content: query, timestamp: Date.now() }] },
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs[serviceTier])]),
      temperature: 0.4,
      maxTokens,
      headers: serviceTier === "flex" ? FLEX_HEADERS : undefined,
      onPayload: (payload) => withGrounding(payload, serviceTier),
      onProviderStreamEvent: (chunk) => collectGrounding(chunk, grounding),
    },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta;
      onText(text);
    }
  }
  return { message: await stream.result(), grounding };
}

const failed = (message: AssistantMessage) => message.stopReason === "error" || message.stopReason === "aborted";

async function runSearch(
  query: string,
  depth: Depth,
  signal: AbortSignal,
  ctx: ExtensionToolContext,
  onText: (text: string) => void,
) {
  const { model, location } = await resolveVertex(ctx);

  let serviceTier: ServiceTier = pricingPreference === "flex" && !flexUnavailableForSession ? "flex" : "standard";
  let result = await requestTier(ctx, model, depth, query, serviceTier, signal, onText);
  if (serviceTier === "flex" && failed(result.message) && !signal.aborted) {
    // Flex either is unsupported here or queued until timeout; stop paying that wait each call.
    flexUnavailableForSession = true;
    serviceTier = "standard";
    result = await requestTier(ctx, model, depth, query, serviceTier, signal, onText);
  }

  const { message, grounding } = result;
  if (signal.aborted) throw new Error("aborted");
  if (message.stopReason === "aborted") throw new Error("Vertex AI Gemini request timed out.");
  if (message.stopReason === "error") {
    throw new Error(`Vertex AI Gemini API error: ${message.errorMessage ?? "unknown"}`);
  }

  const answer =
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim() || "(no answer returned)";

  // Resolve redirect URLs to pure links in parallel (best-effort, bounded).
  const resolved = await Promise.all([...grounding.urls].slice(0, MAX_SOURCES).map((u) => resolveUrl(u, signal)));
  const sources = [...new Set(resolved)].map((url) => ({ host: hostOf(url), url }));

  const searchQueries = [...grounding.queries];
  const usage = searchUsage(message.usage, serviceTier, Math.max(searchQueries.length, sources.length > 0 ? 1 : 0));
  const output: SearchOutput = {
    answer,
    sources,
    searchQueries,
    model: model.id,
    location,
    serviceTier,
    costUsd: usage.cost.total,
  };
  const sourceLines = sources.map((s, i) => `${i + 1}. ${s.host ? `${s.host} — ` : ""}${s.url}`);
  const text = sourceLines.length > 0 ? `${answer}\n\nSources:\n${sourceLines.join("\n")}` : answer;

  return {
    content: [{ type: "text" as const, text }],
    details: output,
    structuredContent: output,
    usage,
  };
}

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function renderSearchResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: { isError: boolean },
) {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

  if (options.isPartial) {
    const preview = text.trim().split("\n").slice(-COLLAPSED_ANSWER_LINES).join("\n");
    return new Text(
      [theme.fg("warning", "Searching the web…"), preview && theme.fg("dim", preview)].filter(Boolean).join("\n"),
      0,
      0,
    );
  }

  const output = result.details as Partial<SearchOutput> | undefined;
  // Errors, and results recorded by earlier versions, have no structured details.
  if (context.isError || typeof output?.answer !== "string") {
    return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
  }

  const sources = output.sources ?? [];
  const tier = output.serviceTier === "flex" ? "flex pricing" : "standard pricing";
  const meta = [
    output.model,
    output.location,
    money(output.costUsd ?? 0),
    `${sources.length} source${sources.length === 1 ? "" : "s"}`,
    tier,
  ].join(" · ");
  const view = new Container();
  view.addChild(new Text(`${theme.fg("accent", theme.bold("◆ Gemini Search"))} ${theme.fg("dim", meta)}`, 0, 0));
  view.addChild(new Spacer(1));

  if (!options.expanded) {
    // Preview prose lines, not the blank lines and rules between sections.
    const lines = output.answer.split("\n").filter((line) => line.trim() && !/^\s*([-*_])\1{2,}\s*$/.test(line));
    view.addChild(new Markdown(lines.slice(0, COLLAPSED_ANSWER_LINES).join("\n"), 0, 0, getMarkdownTheme()));
    if (lines.length > COLLAPSED_ANSWER_LINES || sources.length > 0) {
      view.addChild(
        new Text(`${theme.fg("dim", "…")} ${keyHint("app.tools.expand", "to show the full answer and sources")}`, 0, 0),
      );
    }
    return view;
  }

  view.addChild(new Markdown(output.answer, 0, 0, getMarkdownTheme()));
  if (sources.length > 0) {
    const lines = sources.map(
      (source, index) =>
        `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", source.host)} ${osc8(source.url, theme.fg("mdLink", source.url))}`,
    );
    view.addChild(new Spacer(1));
    view.addChild(new Text([theme.fg("accent", theme.bold("Sources")), ...lines].join("\n"), 0, 0));
  }
  return view;
}

const SEARCH_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function searchTool(depth: Depth) {
  return {
    outputSchema: SearchOutput,
    annotations: SEARCH_ANNOTATIONS,
    parameters: Type.Object({
      query: Type.String({
        description:
          depth === "short"
            ? "The specific fact or question to verify on the web."
            : "The complex topic or research question to investigate on the web.",
      }),
    }),
    execute: (
      _toolCallId: string,
      params: { query: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined,
      ctx: ExtensionToolContext,
    ) =>
      runSearch(params.query, depth, signal ?? new AbortController().signal, ctx, (text) =>
        onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
      ),
    renderResult: renderSearchResult,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("search-pricing", {
    description: "Show or set the Vertex Gemini Search pricing tier: flex or standard.",
    getArgumentCompletions: (prefix) =>
      ["standard", "flex", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
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
            ? "Flex failed earlier in this session; searches currently use standard."
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
    promptSnippet: "Quick grounded web fact-check with source URLs",
    ...searchTool("short"),
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
    promptSnippet: "In-depth grounded web research with source URLs",
    ...searchTool("long"),
  });
}
