import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchRequest, FetchResponse, ReplyRequest } from "./types.js";

const GENERATED_FILE_PATTERNS = [
  /(?:^|\/)[^/]*\.connect\.go$/,
  /(?:^|\/)[^/]*\.grpc\.pb\.(?:cc|h)$/,
  /(?:^|\/)[^/]*\.pb\.(?:cc|go|h)$/,
  /(?:^|\/)[^/]*\.sql\.go$/,
  /(?:^|\/)[^/]*_(?:connect|pb)\.(?:d\.ts|js|ts)$/,
  /(?:^|\/)[^/]*_gen\.(?:json|md)$/,
  /(?:^|\/)[^/]*_grpc\.pb\.go$/,
  /(?:^|\/)[^/]*_pb2(?:_grpc)?\.(?:py|pyi)$/,
  /(?:^|\/)build\/cpp\/CMakeFiles\//,
  /(?:^|\/)gen\//,
  /(?:^|\/)oas_[^/]*_gen\.go$/,
  /(?:^|\/)table_definitions\.yaml$/,
  /(?:^|\/)web\/src\/(?:api\/gen|gen)\//,
];

export interface ReviewArtifactPaths {
  directory: string;
  commandRequestPath: string;
  fetchRequestPath: string;
  fetchResponsePath: string;
  diffPath: string;
}

interface CommandRequest {
  arguments: string;
  cwd: string;
  include_author_comments: boolean;
  requested_pull_number: number | null;
  started_at: string;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isGeneratedPath(filePath: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function filterGeneratedDiff(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const header = section.match(/^diff --git a\/.+? b\/(.+)$/m);
      return !header || !isGeneratedPath(header[1] ?? "");
    })
    .join("");
}

export async function createReviewArtifactDirectory(request: CommandRequest): Promise<ReviewArtifactPaths> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-review-comments-"));
  const paths = {
    directory,
    commandRequestPath: path.join(directory, "command-request.json"),
    fetchRequestPath: path.join(directory, "fetch-request.json"),
    fetchResponsePath: path.join(directory, "fetch-response.json"),
    diffPath: path.join(directory, "authored.diff"),
  };
  await writeFile(paths.commandRequestPath, formatJson(request), "utf8");
  return paths;
}

export async function writeFetchArtifacts(
  paths: ReviewArtifactPaths,
  request: FetchRequest,
  diff: string,
  responseWithoutPath: Omit<FetchResponse, "authored_diff_path">,
): Promise<FetchResponse> {
  const response: FetchResponse = { ...responseWithoutPath, authored_diff_path: paths.diffPath };
  await Promise.all([
    writeFile(paths.fetchRequestPath, formatJson(request), "utf8"),
    writeFile(paths.diffPath, filterGeneratedDiff(diff), "utf8"),
    writeFile(paths.fetchResponsePath, formatJson(response), "utf8"),
  ]);
  return response;
}

export async function writeReplyRequest(directory: string, request: ReplyRequest): Promise<string> {
  const operationNumbers = (await readdir(directory))
    .map((name) => name.match(/^reply-(\d+)-/))
    .map((match) => Number(match?.[1] ?? 0));
  const operationNumber = Math.max(0, ...operationNumbers) + 1;
  const safeThreadId = encodeURIComponent(request.thread_id);
  const requestPath = path.join(
    directory,
    `reply-${operationNumber.toString().padStart(3, "0")}-${safeThreadId}-request.json`,
  );
  await writeFile(requestPath, formatJson(request), "utf8");
  return requestPath;
}
