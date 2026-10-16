#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL = "gpt-transcribe";
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const FFPROBE_TIMEOUT_MS = 15_000;

const MEDIA_TYPES = new Map([
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

const SUPPORTED_PROBE_FORMAT_NAMES = new Set(["m4a", "matroska", "mov", "mp3", "mp4", "mpeg", "wav", "webm"]);

type PersonalSecrets = {
  openai?: { apiKey?: string };
};

type TranscriptionResponse = {
  text?: unknown;
  languages?: unknown;
};

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ProbeImplementation = (inputPath: string, signal?: AbortSignal) => Promise<AudioProbe>;
type SaveOutput = (outputPath: string, outputDir: string, text: string) => Promise<void>;

export type AudioProbe = {
  formatNames: string[];
  audioCodecs: string[];
  durationSeconds?: number;
};

export type CommandExecutor = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type TranscriptionOptions = {
  cwd: string;
  path: string;
  prompt?: string;
  signal?: AbortSignal;
  secretsFile: string;
  outputDir: string;
  fetchImpl?: FetchImplementation;
  probeImpl?: ProbeImplementation;
  saveOutput?: SaveOutput;
  now?: Date;
};

export type TranscriptionResult = {
  inputPath: string;
  outputPath: string;
  text: string;
  languages: string[];
  sizeBytes: number;
  probe: AudioProbe;
};

type FfprobeOutput = {
  format?: { duration?: unknown; format_name?: unknown };
  streams?: Array<{ codec_name?: unknown; codec_type?: unknown }>;
};

export function normalizeInputPath(cwd: string, path: string): string {
  const withoutAtPrefix = path.startsWith("@") ? path.slice(1) : path;
  if (!withoutAtPrefix.trim()) throw new Error("Audio path must not be empty.");
  return resolve(cwd, withoutAtPrefix);
}

export function getSupportedMediaType(inputPath: string): string {
  const extension = extname(inputPath).toLowerCase();
  const mediaType = MEDIA_TYPES.get(extension);
  if (!mediaType) {
    throw new Error(
      `Unsupported audio format ${extension || "(none)"}. Supported formats: ${[...MEDIA_TYPES.keys()].join(", ")}.`,
    );
  }
  return mediaType;
}

export function validateFfprobeOutput(output: unknown, inputPath: string): AudioProbe {
  if (!output || typeof output !== "object") throw new Error(`ffprobe returned invalid metadata for ${inputPath}.`);

  const probe = output as FfprobeOutput;
  const rawFormatName = probe.format?.format_name;
  if (typeof rawFormatName !== "string" || !rawFormatName.trim()) {
    throw new Error(`ffprobe could not identify the media format for ${inputPath}.`);
  }

  const formatNames = rawFormatName
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const audioStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length === 0) throw new Error(`ffprobe found no audio stream in ${inputPath}.`);
  if (!formatNames.some((name) => SUPPORTED_PROBE_FORMAT_NAMES.has(name))) {
    throw new Error(
      `ffprobe detected unsupported format ${rawFormatName} for ${inputPath}. Supported transcription formats: ${[...MEDIA_TYPES.keys()].join(", ")}.`,
    );
  }

  const audioCodecs = audioStreams.flatMap((stream) =>
    typeof stream.codec_name === "string" && stream.codec_name.trim() ? [stream.codec_name.trim()] : [],
  );
  const duration = typeof probe.format?.duration === "string" ? Number.parseFloat(probe.format.duration) : Number.NaN;
  return {
    formatNames,
    audioCodecs,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
  };
}

async function executeCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { signal: options.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function probeAudioFile(
  exec: CommandExecutor,
  inputPath: string,
  signal?: AbortSignal,
): Promise<AudioProbe> {
  const result = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      inputPath,
    ],
    { signal, timeout: FFPROBE_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(
      `ffprobe could not validate ${inputPath}: ${result.stderr.trim() || `exited with status ${result.code}`}`,
    );
  }

  try {
    return validateFfprobeOutput(JSON.parse(result.stdout), inputPath);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`ffprobe returned invalid JSON for ${inputPath}: ${error.message}`);
    throw error;
  }
}

export function readApiKey(contents: string, secretsFile: string): string {
  let secrets: PersonalSecrets;
  try {
    secrets = JSON.parse(contents) as PersonalSecrets;
  } catch (error) {
    throw new Error(
      `Unable to parse OpenAI credentials in ${secretsFile}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const apiKey = secrets.openai?.apiKey?.trim();
  if (!apiKey) throw new Error(`Missing OpenAI API key at openai.apiKey in ${secretsFile}.`);
  return apiKey;
}

export function normalizeLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((language) => {
    if (typeof language === "string" && language.trim()) return [language.trim()];
    if (!language || typeof language !== "object") return [];
    const code = (language as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? [code.trim()] : [];
  });
}

function transcriptFileName(inputPath: string, now: Date): string {
  const safeStem =
    parse(basename(inputPath))
      .name.replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "transcript";
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(".", "-");
  return `${safeStem}-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
}

function apiErrorMessage(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    else if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    // Keep a non-JSON response as the diagnostic.
  }
  return `OpenAI transcription failed (HTTP ${status})${detail ? `: ${detail.slice(0, 1_000)}` : "."}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function saveTranscript(outputPath: string, outputDir: string, text: string): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function transcribeAudio(options: TranscriptionOptions): Promise<TranscriptionResult> {
  const inputPath = normalizeInputPath(options.cwd, options.path);
  const mediaType = getSupportedMediaType(inputPath);
  const probe = await (options.probeImpl ?? ((path, signal) => probeAudioFile(executeCommand, path, signal)))(
    inputPath,
    options.signal,
  );

  let audio: Buffer;
  try {
    audio = await readFile(inputPath);
  } catch (error) {
    throw new Error(`Unable to read audio file ${inputPath}: ${error instanceof Error ? error.message : error}`);
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio file is ${formatBytes(audio.byteLength)}, exceeding the OpenAI transcription limit of ${formatBytes(MAX_AUDIO_BYTES)}. Compress or split it first.`,
    );
  }

  let secretsContents: string;
  try {
    secretsContents = await readFile(options.secretsFile, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read OpenAI credentials from ${options.secretsFile}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const form = new FormData();
  form.append("model", MODEL);
  form.append("file", new Blob([audio], { type: mediaType }), basename(inputPath));
  if (options.prompt?.trim()) form.append("prompt", options.prompt.trim());

  const response = await (options.fetchImpl ?? fetch)(TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${readApiKey(secretsContents, options.secretsFile)}` },
    body: form,
    signal: options.signal,
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(apiErrorMessage(response.status, responseBody));

  let payload: TranscriptionResponse;
  try {
    payload = JSON.parse(responseBody) as TranscriptionResponse;
  } catch (error) {
    throw new Error(
      `OpenAI returned an invalid transcription response: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (typeof payload.text !== "string") throw new Error("OpenAI transcription response did not contain text.");

  const outputPath = join(options.outputDir, transcriptFileName(inputPath, options.now ?? new Date()));
  await (options.saveOutput ?? saveTranscript)(outputPath, options.outputDir, payload.text);
  return {
    inputPath,
    outputPath,
    text: payload.text,
    languages: normalizeLanguages(payload.languages),
    sizeBytes: audio.byteLength,
    probe,
  };
}

function parseArguments(args: string[]): { path: string; prompt?: string } {
  let path: string | undefined;
  let prompt: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      if (args[index + 1] === undefined || args[index + 2] !== undefined)
        throw new Error("Expected exactly one audio path after --.");
      path = args[index + 1];
      break;
    }
    if (arg === "--prompt") {
      prompt = args[++index];
      if (prompt === undefined) throw new Error("--prompt requires a value.");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: transcribe-audio.ts [--prompt <context>] -- <audio-path>");
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (path === undefined) path = arg;
    else throw new Error("Expected exactly one audio path.");
  }
  if (!path) throw new Error("Missing audio path. Use --help for usage.");
  return { path, prompt };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const result = await transcribeAudio({
    cwd: process.cwd(),
    path: args.path,
    prompt: args.prompt,
    signal: controller.signal,
    secretsFile: join(homedir(), ".pi", "secrets", "personal.json"),
    outputDir: join(homedir(), ".pi", "agent", "transcriptions"),
  });
  const summary = {
    inputPath: result.inputPath,
    outputPath: result.outputPath,
    model: MODEL,
    languages: result.languages,
    audioBytes: result.sizeBytes,
    media: result.probe,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
