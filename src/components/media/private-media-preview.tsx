"use client";

import Image from "next/image";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";

export type PrivateMediaKind = "image" | "video";
export type PrivateMediaReadiness = "preparing" | "ready" | "failed";

type PrivateMediaPreviewProps = {
  assetId: string;
  kind: PrivateMediaKind;
  alt: string;
  className?: string;
  mediaClassName?: string;
  compact?: boolean;
  onReadinessChange?: (readiness: PrivateMediaReadiness) => void;
};

const MAX_AUTOMATIC_RETRIES = 18;
const captureAssetIdPattern = /^[a-zA-Z0-9_-]{1,200}$/;

/**
 * Renders only owner-scoped Capture content routes constructed from a validated
 * opaque asset id. Provider URLs and caller-supplied URLs are deliberately not
 * accepted by this component.
 */
export function PrivateMediaPreview({
  assetId,
  kind,
  alt,
  className,
  mediaClassName,
  compact = false,
  onReadinessChange,
}: PrivateMediaPreviewProps) {
  const safeAssetId = normalizePrivateMediaAssetId(assetId);
  return (
    <PrivateMediaPreviewState
      key={`${kind}:${safeAssetId || "invalid"}`}
      safeAssetId={safeAssetId}
      kind={kind}
      alt={alt}
      className={className}
      mediaClassName={mediaClassName}
      compact={compact}
      onReadinessChange={onReadinessChange}
    />
  );
}

function PrivateMediaPreviewState({
  safeAssetId,
  kind,
  alt,
  className,
  mediaClassName,
  compact,
  onReadinessChange,
}: Omit<PrivateMediaPreviewProps, "assetId"> & { safeAssetId?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [retryPending, setRetryPending] = useState(false);
  const [readiness, setReadiness] = useState<PrivateMediaReadiness>(
    safeAssetId ? "preparing" : "failed",
  );

  useEffect(() => {
    onReadinessChange?.(readiness);
  }, [onReadinessChange, readiness]);

  useEffect(() => {
    if (!retryPending || readiness !== "preparing") return;
    const timeout = window.setTimeout(() => {
      setRetryPending(false);
      setAttempt((current) => current + 1);
    }, privateMediaRetryDelay(attempt));
    return () => window.clearTimeout(timeout);
  }, [attempt, readiness, retryPending]);

  const contentUrl = useMemo(
    () => safeAssetId
      ? privateCaptureAssetContentUrl(safeAssetId, { attempt })
      : undefined,
    [attempt, safeAssetId],
  );

  function handleLoad() {
    setRetryPending(false);
    setReadiness("ready");
  }

  function handleError() {
    const next = privateMediaFailureState({
      attempt,
      maxAutomaticRetries: MAX_AUTOMATIC_RETRIES,
      wasReady: readiness === "ready",
    });
    setReadiness(next.readiness);
    setRetryPending(next.retry);
  }

  function retryNow() {
    if (!safeAssetId) return;
    setRetryPending(false);
    setReadiness("preparing");
    setAttempt((current) => current + 1);
  }

  return (
    <div
      className={clsx(
        "relative grid min-h-40 w-full place-items-center overflow-hidden rounded-lg bg-surface-raised",
        compact && "min-h-32",
        className,
      )}
      data-private-media-readiness={readiness}
    >
      {contentUrl ? kind === "image" ? (
        <Image
          key={contentUrl}
          src={contentUrl}
          alt={alt}
          width={1536}
          height={1024}
          unoptimized
          onLoad={handleLoad}
          onError={handleError}
          aria-hidden={readiness !== "ready"}
          className={clsx(
            "max-h-full w-auto max-w-full rounded-lg object-contain transition-opacity",
            readiness === "ready" ? "opacity-100" : "opacity-0",
            mediaClassName,
          )}
        />
      ) : (
        <video
          key={contentUrl}
          src={contentUrl}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={handleLoad}
          onError={handleError}
          tabIndex={readiness === "ready" ? 0 : -1}
          aria-hidden={readiness !== "ready"}
          className={clsx(
            "max-h-full w-full rounded-lg object-contain transition-opacity",
            readiness === "ready" ? "opacity-100" : "opacity-0",
            mediaClassName,
          )}
          aria-label={alt}
        >
          Your browser does not support this private video.
        </video>
      ) : null}

      {readiness === "preparing" ? (
        <div className="absolute inset-0 grid place-items-center bg-surface-raised/95 p-5 text-center" role="status">
          <div className="max-w-sm">
            <Loader2 className="mx-auto animate-spin text-primary" size={compact ? 22 : 28} aria-hidden="true" />
            <p className={clsx("font-semibold", compact ? "mt-2 text-sm" : "mt-3 text-base")}>Preparing your private {kind}</p>
            <p className={clsx("mt-1 leading-5 text-muted", compact ? "text-xs" : "text-sm")}>The result is saved. It will appear after encrypted storage verifies the file.</p>
          </div>
        </div>
      ) : readiness === "failed" ? (
        <div className="absolute inset-0 grid place-items-center bg-surface-raised p-5 text-center" role="alert">
          <div className="max-w-sm">
            <AlertCircle className="mx-auto text-danger" size={compact ? 22 : 28} aria-hidden="true" />
            <p className={clsx("font-semibold", compact ? "mt-2 text-sm" : "mt-3 text-base")}>Preview unavailable</p>
            <p className={clsx("mt-1 leading-5 text-muted", compact ? "text-xs" : "text-sm")}>{safeAssetId ? "The file is still processing or could not be decoded safely." : "This media reference is invalid."}</p>
            {safeAssetId ? (
              <button type="button" onClick={retryNow} className="action-button mt-3">
                <RefreshCw size={14} aria-hidden="true" />Try preview again
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function normalizePrivateMediaAssetId(value: string) {
  const id = value.trim();
  return captureAssetIdPattern.test(id) ? id : undefined;
}

export function privateCaptureAssetContentUrl(
  assetId: string,
  options: { attempt?: number; download?: boolean } = {},
) {
  const id = normalizePrivateMediaAssetId(assetId);
  if (!id) return undefined;
  const query = new URLSearchParams({ content: "1" });
  if (options.download) query.set("download", "1");
  if (Number.isSafeInteger(options.attempt) && (options.attempt || 0) > 0) {
    query.set("previewAttempt", String(Math.min(options.attempt!, 10_000)));
  }
  return `/api/capture/assets/${encodeURIComponent(id)}?${query.toString()}`;
}

export function privateMediaRetryDelay(attempt: number) {
  const boundedAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  return Math.min(15_000, 2_000 + boundedAttempt * 1_000);
}

export function privateMediaFailureState(input: {
  attempt: number;
  maxAutomaticRetries: number;
  wasReady: boolean;
}): { readiness: PrivateMediaReadiness; retry: boolean } {
  const retry = !input.wasReady && input.attempt < input.maxAutomaticRetries;
  return { readiness: retry ? "preparing" : "failed", retry };
}
