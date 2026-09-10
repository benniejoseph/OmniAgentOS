import "server-only";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2_000;

export async function clipVideoBytes(input: {
  bytes: Uint8Array;
  mediaType: string;
  startSeconds: number;
  endSeconds: number;
  abortSignal?: AbortSignal;
}) {
  const executablePath = resolveFfmpegPath();
  if (!input.mediaType.startsWith("video/")) throw new Error("The source asset is not a video.");
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("The source video must be 20 MB or smaller.");
  if (!Number.isFinite(input.startSeconds) || !Number.isFinite(input.endSeconds) || input.startSeconds < 0 || input.endSeconds <= input.startSeconds || input.endSeconds - input.startSeconds > 600) {
    throw new Error("Choose a valid clip range no longer than 10 minutes.");
  }
  input.abortSignal?.throwIfAborted();
  const extension = input.mediaType.includes("webm") ? "webm" : "mp4";
  const directory = await mkdtemp(path.join(tmpdir(), "asael-media-"));
  const sourcePath = path.join(directory, `source.${extension}`);
  const outputPath = path.join(directory, `clip.${extension}`);
  try {
    await writeFile(sourcePath, input.bytes, { mode: 0o600 });
    await runFfmpeg(executablePath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(input.startSeconds),
      "-i",
      sourcePath,
      "-t",
      String(input.endSeconds - input.startSeconds),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      outputPath,
    ], input.abortSignal);
    const bytes = await readFile(outputPath);
    if (!bytes.byteLength) throw new Error("The media processor produced an empty clip.");
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("The clip is larger than 20 MB. Choose a shorter range.");
    return { bytes, mediaType: extension === "webm" ? "video/webm" : "video/mp4", extension };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function resolveFfmpegPath(options: {
  bundledPath?: string | null;
  workingDirectory?: string;
} = {}) {
  const filename = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    options.bundledPath === undefined ? ffmpegPath : options.bundledPath,
    path.join(options.workingDirectory || process.cwd(), "node_modules", "ffmpeg-static", filename),
  ];
  const resolved = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!resolved) throw new Error("The deterministic media processor is unavailable.");
  return resolved;
}

function runFfmpeg(executablePath: string, args: string[], abortSignal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    const abort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_CHARS);
    });
    child.once("error", (error) => {
      abortSignal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      abortSignal?.removeEventListener("abort", abort);
      if (abortSignal?.aborted) {
        reject(abortSignal.reason instanceof Error ? abortSignal.reason : new DOMException("Aborted", "AbortError"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Video clipping failed (${signal || code || "unknown"}): ${diagnostics || "No diagnostic was returned."}`));
      }
    });
  });
}
