import type { CommandContextCatalogItem } from "@/lib/command/composer-context-contract";
import { startVisiblePolling } from "@/lib/client/visible-polling";
import type { VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";

export type PendingCommandAttachment = Readonly<{ assetId: string; label: string }>;
export type CommandUploadAttempt = Readonly<{ file: File; requestId: string }>;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

export function prepareCommandUploads(files: readonly File[], randomId = () => crypto.randomUUID()): CommandUploadAttempt[] {
  if (files.length > 10) throw new Error("Attach up to 10 files at a time.");
  // Validate the entire selection before storing any of it.
  for (const file of files) if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than the 6 MB Command upload limit.`);
  return files.map(file => ({ file, requestId: `command-attachment-${randomId()}` }));
}

export async function uploadCommandAttachments(input: {
  attempts: readonly CommandUploadAttempt[];
  signal: AbortSignal;
  onStored: (attachment: PendingCommandAttachment) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ remaining: readonly CommandUploadAttempt[]; error?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (let index = 0; index < input.attempts.length; index += 1) {
    const attempt = input.attempts[index];
    try {
      input.signal.throwIfAborted();
      const form = new FormData();
      form.set("file", attempt.file);
      form.set("title", attempt.file.name.replace(/\.[^.]+$/, ""));
      form.set("tags", "command-context");
      const response = await fetchImpl("/api/capture", { method: "POST", body: form,
        headers: { "idempotency-key": attempt.requestId },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(record(body) && typeof body.error === "string" ? body.error : `${attempt.file.name} could not be uploaded.`);
      const asset = record(body) && record(body.asset) ? body.asset : undefined;
      if (!asset || typeof asset.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(asset.id)) {
        throw new Error(`${attempt.file.name} was not confirmed. Retry the same upload.`);
      }
      input.signal.throwIfAborted();
      // Each confirmed file survives any later file's rejection or timeout.
      input.onStored({ assetId: asset.id, label: attempt.file.name });
    } catch (error) {
      return { remaining: input.attempts.slice(index), error: error instanceof Error ? error.message : "The upload outcome could not be confirmed." };
    }
  }
  return { remaining: [] };
}

export async function readCommandAttachment(attachment: PendingCommandAttachment, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const libraryId = `library:capture_asset:${attachment.assetId}`;
  const response = await fetchImpl(`/api/library/${encodeURIComponent(libraryId)}`, { cache: "no-store", signal });
  // A just-written asset can precede its readable Library projection.
  if (response.status === 404) return { state: "processing" as const };
  if (!response.ok) throw new Error("Attachment readiness could not be checked.");
  const body: unknown = await response.json();
  // Command can render before this optional upload's full Library validator is
  // needed. Keep the exact same receipt/version validation after it loads.
  const { workspaceLibraryItemSchema } = await import("@/lib/library/contracts");
  signal.throwIfAborted();
  const item = workspaceLibraryItemSchema.parse(record(body) ? body.item : undefined);
  if (item.id !== libraryId || item.sourceAuthority !== "capture_asset" || item.sourceId !== attachment.assetId) {
    throw new Error("The attachment response did not match the uploaded file.");
  }
  const reference: CommandContextCatalogItem = { kind: "file", id: item.id, label: item.title,
    description: `${item.sourceLabel} · ${item.summary || "Ready as command context"}`,
    state: item.status, selectable: item.status === "ready", sourceId: item.sourceId,
    expectedVersion: item.currentVersion.versionNumber, versionId: item.currentVersion.versionId,
    bindingSha256: item.currentVersion.contentSha256 };
  return { state: item.status, reference };
}

/** Exact IDs only; at most 24 serial passes, then an explicit owner retry. */
export function followCommandAttachments(input: {
  attachments: readonly PendingCommandAttachment[];
  onReady: (attachment: PendingCommandAttachment, reference: CommandContextCatalogItem) => void;
  onFailed: (attachment: PendingCommandAttachment) => void;
  onPaused: (remaining: readonly PendingCommandAttachment[]) => void;
  read?: typeof readCommandAttachment;
  environment?: VisibleRefreshEnvironment;
}) {
  const pending = new Map(input.attachments.map(item => [item.assetId, item]));
  let passes = 0;
  let stop = () => {};
  stop = startVisiblePolling({ intervalMs: 10_000, maxIntervalMs: 30_000,
    environment: input.environment,
    poll: async signal => {
      if (++passes > 24) { input.onPaused([...pending.values()]); return false; }
      for (const attachment of pending.values()) {
        const result = await (input.read ?? readCommandAttachment)(attachment, signal);
        if (signal.aborted) return true;
        if (result.state === "ready" && result.reference) {
          pending.delete(attachment.assetId); input.onReady(attachment, result.reference);
        } else if (result.state === "failed" || result.state === "unsupported") {
          pending.delete(attachment.assetId); input.onFailed(attachment);
        }
      }
      return pending.size > 0;
    },
    onError: () => {
      if (passes >= 24) { input.onPaused([...pending.values()]); stop(); }
    },
  });
  return stop;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
