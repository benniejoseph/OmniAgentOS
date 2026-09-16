import type { BrowserActivityItem } from "@/lib/runs/activity";

const MAX_COMPUTER_USE_EVIDENCE = 24;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const OPERATION = /^browser_[a-z_]{1,80}$/;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ComputerUseEvidenceSummary = Readonly<{
  executionId: string;
  sequence: number;
  action: string;
  operation: string;
  status: BrowserActivityItem["status"];
  at: string;
  targetOrigin?: string;
  frame: Readonly<{
    id: string;
    mediaType: string;
    byteCount: number;
    filename: string;
    contentUrl: string;
  }>;
}>;

/**
 * Builds a bounded native-client projection from authoritative run activity.
 * URLs and filenames are reconstructed locally; no connector-returned path or
 * page title becomes a download target.
 */
export function projectComputerUseEvidence(
  runId: string,
  activity: readonly BrowserActivityItem[],
): ComputerUseEvidenceSummary[] {
  if (!OPAQUE_ID.test(runId)) return [];
  return activity.flatMap((item): ComputerUseEvidenceSummary[] => {
    const frame = item.frame;
    if (
      !frame ||
      !OPAQUE_ID.test(item.id) ||
      !OPAQUE_ID.test(frame.id) ||
      !OPERATION.test(item.operation) ||
      !IMAGE_MEDIA_TYPES.has(frame.mimeType) ||
      !Number.isSafeInteger(frame.byteCount) ||
      frame.byteCount <= 0 ||
      frame.byteCount > 1_500_000 ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence < 0
    ) {
      return [];
    }
    const targetOrigin = safeOrigin(item.targetOrigin);
    const extension = frame.mimeType === "image/jpeg"
      ? "jpg"
      : frame.mimeType === "image/webp"
        ? "webp"
        : "png";
    return [{
      executionId: item.id,
      sequence: item.sequence,
      action: boundedText(item.action, 120) || "Computer Use observation",
      operation: item.operation,
      status: item.status,
      at: item.at,
      ...(targetOrigin ? { targetOrigin } : {}),
      frame: {
        id: frame.id,
        mediaType: frame.mimeType,
        byteCount: frame.byteCount,
        filename: `computer-use-${String(item.sequence).padStart(4, "0")}.${extension}`,
        contentUrl:
          `/api/runs/${encodeURIComponent(runId)}/activity/frames/${encodeURIComponent(frame.id)}`,
      },
    }];
  }).slice(-MAX_COMPUTER_USE_EVIDENCE);
}

function safeOrigin(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== value
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function boundedText(value: string, limit: number) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);
}
