"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FileSpreadsheet,
  FileText,
  Files,
  Loader2,
  Presentation,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { clsx } from "clsx";

import {
  projectResultsGeneratedArtifacts,
  type ResultsGeneratedArtifact,
} from "@/lib/results/generated-artifact-projection";

type ShelfState = "loading" | "ready" | "error";

type GeneratedArtifactsShelfProps = Readonly<{
  refreshKey?: string | number;
}>;

export function GeneratedArtifactsShelf({
  refreshKey,
}: GeneratedArtifactsShelfProps) {
  const [items, setItems] = useState<readonly ResultsGeneratedArtifact[]>([]);
  const [state, setState] = useState<ShelfState>("loading");
  const [error, setError] = useState<string>();
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState("loading");
      setError(undefined);
      try {
        const response = await fetch("/api/artifacts?limit=12", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(responseMessage(payload));
        }
        if (controller.signal.aborted) return;
        setItems(projectResultsGeneratedArtifacts(payload));
        setState("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Created files could not be loaded.",
        );
        setState("error");
      }
    }, 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refreshKey, retryNonce]);

  return (
    <GeneratedArtifactsShelfView
      items={items}
      state={state}
      error={error}
      onRetry={() => setRetryNonce((value) => value + 1)}
    />
  );
}

export function GeneratedArtifactsShelfView({
  items,
  state,
  error,
  onRetry,
}: Readonly<{
  items: readonly ResultsGeneratedArtifact[];
  state: ShelfState;
  error?: string;
  onRetry: () => void;
}>) {
  const hasItems = items.length > 0;

  return (
    <section
      className="mt-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
      aria-labelledby="created-files-title"
      aria-busy={state === "loading"}
      data-testid="generated-artifacts-shelf"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Files size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="created-files-title" className="text-sm font-semibold">
                Created files
              </h2>
              {hasItems ? (
                <span className="rounded-md bg-surface-raised px-2 py-1 font-mono text-[0.6875rem] text-muted">
                  {items.length} latest
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">
              Documents Asael creates are kept here with their current version and creation status.
            </p>
          </div>
        </div>
        {state === "loading" && hasItems ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Refreshing files
          </span>
        ) : null}
      </div>

      {state === "loading" && !hasItems ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" role="status" aria-live="polite">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-40 animate-pulse rounded-md border border-line bg-background" />
          ))}
          <span className="sr-only">Loading created files.</span>
        </div>
      ) : null}

      {state === "error" ? (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-warning/45 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">Created files are unavailable</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                {error || "The file list could not be loaded."}
              </p>
            </div>
          </div>
          <button type="button" className="action-button shrink-0" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {state === "ready" && !hasItems ? (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-dashed border-line bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">No created files yet</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Ask Asael to create a presentation; ready files will appear here automatically.
            </p>
          </div>
          <Link href="/app/command" className="action-button shrink-0">
            Create with Asael
          </Link>
        </div>
      ) : null}

      {hasItems ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map((item) => (
            <GeneratedArtifactCard key={`${item.id}:v${item.currentVersion}`} item={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GeneratedArtifactCard({ item }: { item: ResultsGeneratedArtifact }) {
  const status = statusDetails(item.status);

  return (
    <article className="flex min-h-44 flex-col rounded-md border border-line bg-background p-4 transition hover:border-primary/35 hover:bg-surface-raised">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface text-primary">
          {artifactKindIcon(item.kind)}
        </span>
        <span className={clsx("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-semibold", status.tone)}>
          {artifactStatusIcon(item.status)}
          {status.label}
        </span>
      </div>

      <div className="mt-4 min-w-0 flex-1">
        <h3 className="line-clamp-2 text-sm font-semibold leading-5" title={item.title}>
          {item.title}
        </h3>
        <p className="mt-1 truncate text-xs text-muted" title={item.filename}>
          {item.filename}
        </p>
        <p className="mt-3 text-[0.6875rem] text-muted">
          {kindLabel(item.kind)} · v{item.currentVersion}
          {item.byteCount === null ? "" : ` · ${formatBytes(item.byteCount)}`}
        </p>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 border-t border-line pt-3">
        <p className="text-[0.6875rem] text-muted" title={item.updatedAt}>
          Updated {formatTimestamp(item.updatedAt)}
        </p>
        {item.status === "ready" && item.downloadUrl ? (
          <a
            href={item.downloadUrl}
            download={item.filename}
            className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-ink transition hover:opacity-90"
          >
            <Download size={13} aria-hidden="true" />
            Download
          </a>
        ) : (
          <span className="text-[0.6875rem] font-semibold text-muted">
            {item.status === "failed" ? "Needs retry" : "Preparing"}
          </span>
        )}
      </div>
    </article>
  );
}

function artifactKindIcon(kind: ResultsGeneratedArtifact["kind"]) {
  if (kind === "presentation") {
    return <Presentation size={17} aria-hidden="true" />;
  }
  if (kind === "spreadsheet") {
    return <FileSpreadsheet size={17} aria-hidden="true" />;
  }
  return <FileText size={17} aria-hidden="true" />;
}

function artifactStatusIcon(status: ResultsGeneratedArtifact["status"]) {
  if (status === "ready") {
    return <CheckCircle2 size={12} aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle size={12} aria-hidden="true" />;
  }
  if (status === "rendering") {
    return <Loader2 size={12} className="animate-spin" aria-hidden="true" />;
  }
  return <Clock3 size={12} aria-hidden="true" />;
}

function kindLabel(kind: ResultsGeneratedArtifact["kind"]) {
  return {
    document: "Document",
    presentation: "Presentation",
    spreadsheet: "Spreadsheet",
    pdf: "PDF",
  }[kind];
}

function statusDetails(status: ResultsGeneratedArtifact["status"]) {
  if (status === "ready") {
    return {
      label: "Ready",
      tone: "bg-success/10 text-success",
    };
  }
  if (status === "failed") {
    return {
      label: "Failed",
      tone: "bg-danger/10 text-danger",
    };
  }
  if (status === "rendering") {
    return {
      label: "Creating",
      tone: "bg-primary/10 text-primary",
    };
  }
  return {
    label: "Queued",
    tone: "bg-warning/10 text-warning",
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function responseMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Created files could not be loaded.";
  }
  const record = payload as Record<string, unknown>;
  const message = typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : "Created files could not be loaded.";
  const trimmed = message.trim();
  return trimmed && trimmed.length <= 240
    ? trimmed
    : "Created files could not be loaded.";
}
