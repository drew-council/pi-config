import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_CAPTURE_DURATION_MS = 1_500;
const MAX_CAPTURE_DURATION_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5_000;
const OUTPUT_DIR = join(homedir(), ".pi", "agent", "browser-logs");

type BrowserTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  parentId?: string;
};

type RuntimeRemoteObject = {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: {
    type?: string;
    subtype?: string;
    description?: string;
    overflow?: boolean;
    properties?: Array<{
      name?: string;
      type?: string;
      subtype?: string;
      value?: string;
      valuePreview?: unknown;
    }>;
  };
};

type LogEntry = {
  source?: string;
  level?: string;
  text?: string;
  timestamp?: number;
  url?: string;
  lineNumber?: number;
  stackTrace?: unknown;
  networkRequestId?: string;
};

type ConsoleApiCalledParams = {
  type?: string;
  args?: RuntimeRemoteObject[];
  executionContextId?: number;
  timestamp?: number;
  stackTrace?: unknown;
};

type ExceptionThrownParams = {
  timestamp?: number;
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: unknown;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
};

type PageInfo = {
  href?: string;
  title?: string;
  visibilityState?: string;
  hasFocus?: boolean;
  hidden?: boolean;
};

type TargetCandidate = BrowserTarget & {
  score: number;
  pageInfo?: PageInfo;
  selectionReason: string;
};

type BrowserLogEntry = {
  index: number;
  kind: "console" | "exception" | "browser-log";
  source: "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" | "Log.entryAdded";
  level: string;
  timestamp?: number;
  timestampIso?: string;
  message: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  executionContextId?: number;
  args?: Array<ReturnType<typeof normalizeRemoteObject>>;
  stackTrace?: unknown;
};

type BrowserLogOptions = {
  cdpUrl: string;
  durationMs: number;
};

type BrowserLogReport = {
  schemaVersion: 1;
  capturedAt: string;
  durationMs: number;
  cdpUrl: string;
  browser?: unknown;
  target: TargetCandidate;
  candidateTargets: TargetCandidate[];
  summary: {
    totalEntries: number;
    byKind: Record<string, number>;
    byLevel: Record<string, number>;
    firstTimestampIso?: string;
    lastTimestampIso?: string;
  };
  entries: BrowserLogEntry[];
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type WebSocketData = string | Buffer | ArrayBuffer;

type MinimalWebSocket = {
  onopen?: (() => void) | undefined;
  onerror?: (() => void) | undefined;
  onmessage?: ((event: { data: WebSocketData }) => void) | undefined;
  onclose?: (() => void) | undefined;
  send(data: string): void;
  close(): void;
};

type WebSocketConstructor = new (url: string) => MinimalWebSocket;

const browserLogToolSchema = {
  type: "object",
  properties: {
    durationMs: {
      type: "number",
      description: `How long to listen for new browser log events after connecting. Default ${DEFAULT_CAPTURE_DURATION_MS}ms, max ${MAX_CAPTURE_DURATION_MS}ms.`,
    },
    cdpUrl: {
      type: "string",
      description: `Chrome DevTools Protocol HTTP URL. Default ${DEFAULT_CDP_URL}.`,
    },
  },
  additionalProperties: false,
} as const;

const browserLogOutputSchema = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the saved JSON report containing all captured entries." },
    summary: {
      type: "object",
      properties: {
        totalEntries: { type: "integer", minimum: 0 },
        byKind: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
        byLevel: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
        firstTimestampIso: { type: "string" },
        lastTimestampIso: { type: "string" },
      },
      required: ["totalEntries", "byKind", "byLevel"],
      additionalProperties: false,
    },
    target: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
      },
      required: ["id", "title", "url"],
      additionalProperties: false,
    },
  },
  required: ["filePath", "summary", "target"],
  additionalProperties: false,
} as const;

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (message: CdpMessage) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();

  private constructor(private readonly socket: MinimalWebSocket) {}

  static async connect(webSocketDebuggerUrl: string, signal?: AbortSignal): Promise<CdpClient> {
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("This pi/browser-log extension requires a Node.js runtime with global WebSocket support.");
    }

    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    const client = new CdpClient(socket);

    await new Promise<void>((resolveConnect, reject) => {
      if (signal?.aborted) {
        try {
          socket.close();
        } catch {
          // Ignore close errors while aborting startup.
        }
        reject(new Error("Operation aborted"));
        return;
      }

      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        socket.onopen = undefined;
        socket.onerror = undefined;
      };
      const onAbort = () => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close errors while aborting startup.
        }
        reject(new Error("Operation aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      socket.onopen = () => {
        cleanup();
        resolveConnect();
      };
      socket.onerror = () => {
        cleanup();
        reject(new Error(`Unable to connect to ${webSocketDebuggerUrl}`));
      };
    });

    socket.onmessage = (event: { data: WebSocketData }) => client.handleMessage(event.data);
    socket.onclose = () => client.rejectAll(new Error("CDP connection closed"));
    socket.onerror = () => client.rejectAll(new Error("CDP connection error"));

    return client;
  }

  on(method: string, handler: (params: unknown) => void) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    const message = params ? { id, method, params } : { id, method };
    let timeout: NodeJS.Timeout;
    const promise = new Promise<T>((resolveCommand, reject) => {
      timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        timeout,
        resolve: (response) => {
          if (response.error) {
            reject(new Error(`${method} failed: ${response.error.message}`));
          } else {
            resolveCommand(response.result as T);
          }
        },
        reject,
      });
    });

    this.socket.send(JSON.stringify(message));
    return promise;
  }

  close() {
    this.rejectAll(new Error("CDP connection closed"));
    try {
      this.socket.close();
    } catch {
      // Ignore close failures.
    }
  }

  private handleMessage(data: WebSocketData) {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(new Uint8Array(data)).toString("utf8");
    const message = JSON.parse(text) as CdpMessage;

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }

    if (!message.method) return;
    for (const handler of this.handlers.get(message.method) ?? []) {
      handler(message.params);
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function normalizeBrowserLogOptions(options: Partial<BrowserLogOptions>): BrowserLogOptions {
  const configuredCdpUrl = options.cdpUrl?.trim() || process.env.PI_BROWSER_LOG_CDP_URL?.trim() || DEFAULT_CDP_URL;
  const configuredDuration = options.durationMs;
  const durationMs =
    typeof configuredDuration === "number" && Number.isFinite(configuredDuration) && configuredDuration >= 0
      ? Math.min(configuredDuration, MAX_CAPTURE_DURATION_MS)
      : DEFAULT_CAPTURE_DURATION_MS;

  return {
    cdpUrl: configuredCdpUrl.replace(/\/+$/, ""),
    durationMs,
  };
}

function parseBrowserLogArgs(args: string): BrowserLogOptions {
  const options = normalizeBrowserLogOptions({});

  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, "");
    if (!token) continue;

    if (/^https?:\/\//.test(token)) {
      options.cdpUrl = token.replace(/\/$/, "");
      continue;
    }

    const durationMatch = token.match(/^--(?:duration|duration-ms)=(\d+)$/);
    if (durationMatch) {
      options.durationMs = Number.parseInt(durationMatch[1] ?? "", 10);
      continue;
    }

    const portMatch = token.match(/^--port=(\d+)$/);
    if (portMatch) {
      options.cdpUrl = `http://127.0.0.1:${portMatch[1]}`;
      continue;
    }

    const urlMatch = token.match(/^--(?:cdp-url|url)=(https?:\/\/.+)$/);
    if (urlMatch?.[1]) {
      options.cdpUrl = urlMatch[1].replace(/\/$/, "");
      continue;
    }

    if (/^\d+$/.test(token)) {
      options.durationMs = Number.parseInt(token, 10);
    }
  }

  return normalizeBrowserLogOptions(options);
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function isInspectablePage(target: BrowserTarget) {
  if (target.type !== "page") return false;
  if (!target.webSocketDebuggerUrl) return false;
  if (target.url.startsWith("devtools://")) return false;
  if (target.url.startsWith("chrome://")) return false;
  if (target.url.startsWith("chrome-extension://")) return false;
  return true;
}

async function getPageInfo(target: BrowserTarget, signal?: AbortSignal): Promise<PageInfo | undefined> {
  if (!target.webSocketDebuggerUrl) return undefined;
  let client: CdpClient | undefined;
  try {
    client = await CdpClient.connect(target.webSocketDebuggerUrl, signal);
    const result = await client.send<{ result?: { value?: PageInfo } }>(
      "Runtime.evaluate",
      {
        expression:
          "({ href: location.href, title: document.title, visibilityState: document.visibilityState, hasFocus: document.hasFocus(), hidden: document.hidden })",
        returnByValue: true,
      },
      2_000,
    );
    return result.result?.value;
  } catch {
    return undefined;
  } finally {
    client?.close();
  }
}

function scoreTarget(target: BrowserTarget, pageInfo: PageInfo | undefined): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  if (pageInfo?.hasFocus) {
    score += 100;
    reasons.push("document.hasFocus() is true");
  }
  if (pageInfo?.visibilityState === "visible") {
    score += 50;
    reasons.push("document.visibilityState is visible");
  }
  if (target.url.startsWith("http://") || target.url.startsWith("https://")) {
    score += 10;
    reasons.push("HTTP(S) page");
  }
  if (target.title) {
    score += 1;
    reasons.push("has title");
  }

  return { score, reason: reasons.join("; ") || "fallback candidate" };
}

async function chooseActiveTarget(cdpUrl: string, signal?: AbortSignal) {
  const targets = await fetchJson<BrowserTarget[]>(`${cdpUrl}/json/list`, signal);
  const pages = targets.filter(isInspectablePage);
  if (pages.length === 0) {
    throw new Error(`No inspectable Chromium page targets found at ${cdpUrl}`);
  }

  const candidates: TargetCandidate[] = [];
  for (const target of pages) {
    const pageInfo = await getPageInfo(target, signal);
    const { score, reason } = scoreTarget(target, pageInfo);
    candidates.push({ ...target, score, pageInfo, selectionReason: reason });
  }

  candidates.sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  if (!selected?.webSocketDebuggerUrl) {
    throw new Error("Unable to select a Chromium page target with a debugger URL");
  }

  return { selected, candidates };
}

function isoFromTimestamp(timestamp: unknown) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function remoteObjectToText(object: RuntimeRemoteObject | undefined): string {
  if (!object) return "";
  if (object.unserializableValue) return object.unserializableValue;
  if (object.value !== undefined) return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  if (object.description) return object.description;
  if (object.preview?.description) return object.preview.description;
  return object.type ?? "";
}

function formatConsoleArgs(args: RuntimeRemoteObject[] | undefined): string {
  if (!args?.length) return "";

  const first = args[0];
  if (typeof first?.value !== "string") {
    return args.map(remoteObjectToText).filter(Boolean).join(" ");
  }

  const format = first.value;
  let nextArgIndex = 1;
  let output = "";
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char !== "%" || index === format.length - 1) {
      output += char;
      continue;
    }

    const specifier = format[index + 1];
    if (specifier === "%") {
      output += "%";
      index++;
      continue;
    }

    if (specifier === "c") {
      nextArgIndex++;
      index++;
      continue;
    }

    if ("sdifoO".includes(specifier ?? "")) {
      output += remoteObjectToText(args[nextArgIndex]);
      nextArgIndex++;
      index++;
      continue;
    }

    output += char;
  }

  const remaining = args.slice(nextArgIndex).map(remoteObjectToText).filter(Boolean);
  if (remaining.length > 0) output += `${output ? " " : ""}${remaining.join(" ")}`;
  return output.trim();
}

function normalizeRemoteObject(object: RuntimeRemoteObject) {
  return {
    type: object.type,
    subtype: object.subtype,
    className: object.className,
    value: object.value,
    unserializableValue: object.unserializableValue,
    description: object.description,
    preview: object.preview,
    text: remoteObjectToText(object),
  };
}

function trimStackTrace(stackTrace: unknown, maxFrames = 12, maxParentDepth = 2): unknown {
  if (!stackTrace || typeof stackTrace !== "object") return stackTrace;
  const trace = stackTrace as { description?: string; callFrames?: unknown[]; parent?: unknown; parentId?: unknown };
  return {
    description: trace.description,
    callFrames: trace.callFrames?.slice(0, maxFrames),
    parent: maxParentDepth > 0 ? trimStackTrace(trace.parent, maxFrames, maxParentDepth - 1) : undefined,
    parentId: trace.parentId,
  };
}

function normalizeConsoleEvent(index: number, params: ConsoleApiCalledParams): BrowserLogEntry {
  const timestampIso = isoFromTimestamp(params.timestamp);
  return {
    index,
    kind: "console",
    source: "Runtime.consoleAPICalled",
    level: params.type ?? "log",
    timestamp: params.timestamp,
    timestampIso,
    message: formatConsoleArgs(params.args),
    executionContextId: params.executionContextId,
    args: (params.args ?? []).map(normalizeRemoteObject),
    stackTrace: trimStackTrace(params.stackTrace),
  };
}

function normalizeExceptionEvent(index: number, params: ExceptionThrownParams): BrowserLogEntry {
  const details = params.exceptionDetails ?? {};
  const exception = details.exception ?? {};
  const timestampIso = isoFromTimestamp(params.timestamp);
  return {
    index,
    kind: "exception",
    source: "Runtime.exceptionThrown",
    level: "error",
    timestamp: params.timestamp,
    timestampIso,
    message:
      exception.description ??
      (exception.value === undefined ? undefined : String(exception.value)) ??
      details.text ??
      "Uncaught exception",
    url: details.url,
    lineNumber: details.lineNumber,
    columnNumber: details.columnNumber,
    stackTrace: trimStackTrace(details.stackTrace, 20, 4),
  };
}

function normalizeLogEntry(index: number, params: { entry?: LogEntry }): BrowserLogEntry {
  const entry = params.entry ?? {};
  const timestampIso = isoFromTimestamp(entry.timestamp);
  return {
    index,
    kind: "browser-log",
    source: "Log.entryAdded",
    level: entry.level ?? "info",
    timestamp: entry.timestamp,
    timestampIso,
    message: entry.text ?? "",
    url: entry.url,
    lineNumber: entry.lineNumber,
    stackTrace: trimStackTrace(entry.stackTrace),
  };
}

function summarizeEntries(entries: BrowserLogEntry[]): BrowserLogReport["summary"] {
  const byKind: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  const timestamps = entries
    .map((entry) => entry.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp))
    .sort((left, right) => left - right);

  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
  }

  return {
    totalEntries: entries.length,
    byKind,
    byLevel,
    firstTimestampIso: isoFromTimestamp(timestamps[0]),
    lastTimestampIso: isoFromTimestamp(timestamps[timestamps.length - 1]),
  };
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    const onAbort = () => {
      cleanup();
      clearTimeout(timeout);
      reject(new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function browserLogFileName(date: Date) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(".", "-");
  return `browser-log-${timestamp}-${randomUUID().slice(0, 8)}.json`;
}

async function captureBrowserLog(options: BrowserLogOptions, signal?: AbortSignal) {
  const capturedAt = new Date();
  const browser = await fetchJson<unknown>(`${options.cdpUrl}/json/version`, signal).catch(() => undefined);
  const { selected, candidates } = await chooseActiveTarget(options.cdpUrl, signal);
  const entries: BrowserLogEntry[] = [];
  let nextEntryIndex = 0;
  let client: CdpClient | undefined;

  try {
    const selectedDebuggerUrl = selected.webSocketDebuggerUrl;
    if (!selectedDebuggerUrl) throw new Error("Selected Chromium tab has no debugger URL");

    client = await CdpClient.connect(selectedDebuggerUrl, signal);
    client.on("Runtime.consoleAPICalled", (params) => {
      entries.push(normalizeConsoleEvent(nextEntryIndex++, params as ConsoleApiCalledParams));
    });
    client.on("Runtime.exceptionThrown", (params) => {
      entries.push(normalizeExceptionEvent(nextEntryIndex++, params as ExceptionThrownParams));
    });
    client.on("Log.entryAdded", (params) => {
      entries.push(normalizeLogEntry(nextEntryIndex++, params as { entry?: LogEntry }));
    });

    await Promise.all([client.send("Runtime.enable"), client.send("Log.enable")]);
    await sleep(options.durationMs, signal);
  } finally {
    client?.close();
  }

  entries.sort((left, right) => {
    if (left.timestamp === undefined && right.timestamp === undefined) return left.index - right.index;
    if (left.timestamp === undefined) return 1;
    if (right.timestamp === undefined) return -1;
    return left.timestamp - right.timestamp || left.index - right.index;
  });
  entries.forEach((entry, index) => {
    entry.index = index;
  });

  const report: BrowserLogReport = {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    durationMs: options.durationMs,
    cdpUrl: options.cdpUrl,
    browser,
    target: selected,
    candidateTargets: candidates,
    summary: summarizeEntries(entries),
    entries,
  };

  await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const filePath = join(OUTPUT_DIR, browserLogFileName(capturedAt));
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  return { filePath, report };
}

function resultMessage(filePath: string, report: BrowserLogReport) {
  const levels = Object.entries(report.summary.byLevel)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([level, count]) => `${level}: ${count}`)
    .join(", ");

  return [
    "Browser logs captured from the active Chromium tab.",
    `Path: ${filePath}`,
    `Target: ${report.target.title || "(untitled)"} — ${report.target.url}`,
    `Entries: ${report.summary.totalEntries}${levels ? ` (${levels})` : ""}`,
    "The file is structured JSON with metadata, target selection details, and normalized log entries.",
  ].join("\n");
}

function createBrowserLogTool(capture = captureBrowserLog) {
  return {
    name: "capture_browser_log",
    // Deferred exposure would bypass explicit active-tool selection/disablement.
    exposure: "direct" as const,
    namespace: {
      name: "browser",
      description: "Chromium debugging through Chrome DevTools Protocol.",
      instructions:
        "Capture console, exception, and browser logs from an inspectable tab without navigating it. Requires an existing CDP endpoint. The capture writes a JSON report; use filePath to read the full report. /browser-log remains available independently of model tool selection.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    label: "Capture Browser Log",
    description:
      "Capture console, exception, and browser log entries from the active Chromium tab via Chrome DevTools Protocol and save them to a structured JSON file.",
    parameters: browserLogToolSchema,
    outputSchema: browserLogOutputSchema,
    async execute(_toolCallId: string, params: Partial<BrowserLogOptions>, signal?: AbortSignal) {
      const options = normalizeBrowserLogOptions(params);
      const { filePath, report } = await capture(options, signal);
      const { firstTimestampIso, lastTimestampIso, ...counts } = report.summary;
      return {
        content: [{ type: "text" as const, text: resultMessage(filePath, report) }],
        details: { filePath, summary: report.summary, target: report.target },
        structuredContent: {
          filePath,
          summary: {
            ...counts,
            ...(firstTimestampIso === undefined ? {} : { firstTimestampIso }),
            ...(lastTimestampIso === undefined ? {} : { lastTimestampIso }),
          },
          target: { id: report.target.id, title: report.target.title, url: report.target.url },
        },
      };
    },
  };
}

export const _test = {
  createBrowserLogTool,
  normalizeBrowserLogOptions,
  parseBrowserLogArgs,
  isInspectablePage,
  scoreTarget,
  formatConsoleArgs,
  normalizeConsoleEvent,
  normalizeExceptionEvent,
  normalizeLogEntry,
  summarizeEntries,
};

export default function browserLogExtension(pi: ExtensionAPI) {
  pi.registerCommand("browser-log", {
    description: "Capture console, exception, and browser log entries from the active Chromium tab via CDP",
    handler: async (args, ctx) => {
      const options = parseBrowserLogArgs(args);
      ctx.ui.notify(`Capturing Chromium browser logs for ${options.durationMs}ms from ${options.cdpUrl}...`, "info");

      try {
        const { filePath, report } = await captureBrowserLog(options);
        const message = resultMessage(filePath, report);
        ctx.ui.notify(`Browser log saved: ${filePath}`, "info");
        pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Browser log capture failed: ${message}`, "error");
      }
    },
  });

  pi.registerTool(createBrowserLogTool());
}
