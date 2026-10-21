"use client";

import Link from "next/link";
import { memo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FileText, Film, ImageIcon, Loader2, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { parseMarkdownTable } from "@/lib/command/markdown-table";
import { PrivateMediaPreview, privateCaptureAssetContentUrl, type PrivateMediaReadiness } from "@/components/media/private-media-preview";
import { commandArtifactContentUrl, type CommandFileArtifact, type CommandFileArtifactState } from "@/lib/command/artifact-projection";
import { extractLegacyCommandMedia, mergeCommandMediaArtifacts, type CommandMediaArtifact } from "@/lib/command/media-projection";
import { commandWorkspaceArtifactUrl, type CommandWorkspaceArtifact, type CommandWorkspaceArtifactState } from "@/lib/command/workspace-artifact-projection";

type JsonRecord = Record<string, unknown>;

type ClaimSupportState =
  | "supported"
  | "inferred"
  | "disputed"
  | "stale"
  | "unsupported";

export type GroundingReport = {
  assessment?: { sourceCoverage: "available" | "not_available" };
  status: "verified" | "not_required" | "missing" | "invalid";
  citedIds: string[];
  invalidIds: string[];
  sources: Array<{
    citationId: string;
    kind: string;
    title: string;
    confidence?: number;
    url?: string;
    snippet?: string;
    accessedAt?: string;
  }>;
  claimEvidence?: {
    schemaVersion: 1;
    claimEvidenceMapId: string;
    evaluatedAt: string;
    coverage: {
      materialClaimCount: number;
      supportedMaterialClaimCount: number;
      coverageBps: number | null;
    };
    claims: Array<{
      claimId: string;
      startUtf16: number;
      endUtf16Exclusive: number;
      materiality: "material" | "non_material";
      supportState: ClaimSupportState;
      supportReason: string;
      evidenceUnitIds: string[];
    }>;
  };
};

export const ConversationMessageContent = memo(function ConversationMessageContent({
  content,
  grounding: rawGrounding,
  mediaArtifacts = [],
  fileArtifacts = [],
  fileArtifactState = "none",
  workspaceArtifacts = [],
  workspaceArtifactState = "none",
}: {
  content: string;
  grounding?: unknown;
  mediaArtifacts?: readonly CommandMediaArtifact[];
  fileArtifacts?: readonly CommandFileArtifact[];
  fileArtifactState?: CommandFileArtifactState;
  workspaceArtifacts?: readonly CommandWorkspaceArtifact[];
  workspaceArtifactState?: CommandWorkspaceArtifactState;
}) {
  const safeContent = typeof content === "string" ? content : "";
  const grounding = renderSafeGroundingReport(rawGrounding);
  const recoveredMedia = extractLegacyCommandMedia(safeContent);
  const renderedMedia = mergeCommandMediaArtifacts(
    mediaArtifacts,
    recoveredMedia.artifacts,
  );
  const lines = recoveredMedia.content.replaceAll("\r\n", "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  const citations = new Map(
    grounding
      ? citedGroundingSources(grounding).map((source, sourceIndex) => [
          source.citationId,
          { source, index: sourceIndex + 1 },
        ] as const)
      : [],
  );
  const unavailableReferences = [...new Set(
    Array.from(recoveredMedia.content.matchAll(/\[((?:(?:memory|knowledge|graph|web):[^\]\s]+|(?:csm|evidence_unit)_[a-zA-Z0-9_-]+))\]/g), (match) => match[1]),
  )].filter((reference) => !citations.has(reference));
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div key={`code-${index}`} className="my-4 overflow-hidden rounded-xl border border-line bg-foreground text-background">
          {language ? <div className="border-b border-background/30 px-4 py-2 font-mono text-[13px] text-background">{language}</div> : null}
          <pre className="overflow-x-auto p-4 text-xs leading-6"><code>{code.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      const className = level === 1
        ? "mt-7 text-xl font-semibold tracking-tight first:mt-0"
        : level === 2
          ? "mt-6 text-lg font-semibold tracking-tight first:mt-0"
          : "mt-5 text-base font-semibold text-foreground first:mt-0";
      blocks.push(level === 1
        ? <h2 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h2>
        : level === 2
          ? <h3 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h3>
          : <h4 key={`heading-${index}`} className={className}><MessageInline text={heading[2]} citations={citations} /></h4>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`bullets-${index}`} className="my-4 space-y-2 pl-5 text-base leading-relaxed text-foreground">
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`} className="list-disc pl-1"><MessageInline text={item} citations={citations} /></li>)}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`numbers-${index}`} className="my-4 space-y-2 pl-5 text-base leading-relaxed text-foreground">
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`} className="list-decimal pl-1"><MessageInline text={item} citations={citations} /></li>)}
        </ol>,
      );
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="my-4 border-l-2 border-line-strong pl-4 text-base leading-relaxed text-muted">
          <MessageInline text={quote.join(" ")} citations={citations} />
        </blockquote>,
      );
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} className="my-6 border-line" />);
      index += 1;
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(
        <div
          key={`table-${index}`}
          role="region"
          aria-label="Report comparison table"
          tabIndex={0}
          className="my-4 max-w-full overflow-x-auto rounded-xl border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <table className="min-w-full border-collapse text-sm leading-6">
            <caption className="sr-only">Report comparison</caption>
            <thead className="bg-surface-raised">
              <tr>{table.headers.map((header, columnIndex) => (
                <th key={columnIndex} scope="col" style={{ textAlign: table.alignments[columnIndex] }} className="min-w-36 max-w-sm px-4 py-3 align-top font-semibold text-foreground [overflow-wrap:anywhere]">
                  <MessageInline text={header} citations={citations} />
                </th>
              ))}</tr>
            </thead>
            <tbody>{table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-line">
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex} style={{ textAlign: table.alignments[columnIndex] }} className="min-w-36 max-w-sm px-4 py-3 align-top text-foreground [overflow-wrap:anywhere]">
                    <MessageInline text={cell} citations={citations} />
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
      index = table.nextIndex;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !messageBlockStarts(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="my-3 text-base leading-relaxed text-foreground first:mt-0 last:mb-0">
        <MessageInline text={paragraph.join(" ")} citations={citations} />
      </p>,
    );
  }

  return (
    <div className="min-w-0 max-w-[45rem]">
      {blocks.length ? <div className="max-w-[72ch]">{blocks}</div> : null}
      {unavailableReferences.length ? (
        <details className="mt-3 rounded-lg border border-line px-3 py-2 text-xs leading-5 text-muted">
          <summary className="cursor-pointer">Unavailable source details</summary>
          <p className="mt-2">These references could not be matched to source details for this response. They do not establish support for its statements.</p>
          <ul className="mt-1 space-y-1 break-all font-mono">
            {unavailableReferences.map((reference) => <li key={reference}>[{reference}]</li>)}
          </ul>
        </details>
      ) : null}
      {renderedMedia.length ? (
        <div className={clsx("space-y-4", blocks.length ? "mt-5" : "mt-0")}>
          {renderedMedia.map((artifact) => (
            <CommandMediaArtifactCard key={artifact.assetId} artifact={artifact} />
          ))}
        </div>
      ) : null}
      {fileArtifacts.length ? (
        <div className={clsx(
          "space-y-4",
          blocks.length || renderedMedia.length ? "mt-5" : "mt-0",
        )}>
          {fileArtifacts.map((artifact) => (
            <CommandFileArtifactCard
              key={`${artifact.artifactId}:v${artifact.version}`}
              artifact={artifact}
            />
          ))}
        </div>
      ) : null}
      {fileArtifactState === "unavailable" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length ? "mt-5" : "mt-0",
        )} role="status">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-semibold">The created file preview is temporarily unavailable</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              The task result remains available. Refresh this conversation or open Results to retry the private file projection.
            </p>
          </div>
        </div>
      ) : null}
      {workspaceArtifacts.length ? (
        <div className={clsx(
          "grid gap-3 sm:grid-cols-2",
          blocks.length || renderedMedia.length || fileArtifacts.length ? "mt-5" : "mt-0",
        )}>
          {workspaceArtifacts.map((artifact) => (
            <CommandWorkspaceArtifactCard
              key={`${artifact.kind}:${artifact.resourceId}`}
              artifact={artifact}
            />
          ))}
        </div>
      ) : null}
      {workspaceArtifactState === "pending" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-line bg-surface-raised/60 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length || fileArtifacts.length || workspaceArtifacts.length
            ? "mt-5"
            : "mt-0",
        )} role="status" aria-live="polite">
          <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <div>
            <p className="font-semibold">Checking for a Google Workspace result</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Asael is still finalizing this task. Any verified Google file will appear here automatically.
            </p>
          </div>
        </div>
      ) : null}
      {workspaceArtifactState === "unavailable" ? (
        <div className={clsx(
          "flex max-w-2xl items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm",
          blocks.length || renderedMedia.length || fileArtifacts.length || workspaceArtifacts.length
            ? "mt-5"
            : "mt-0",
        )} role="status">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-semibold">The Google Workspace file link is temporarily unavailable</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              The task result remains intact. Refresh this conversation to retry its verified Google file projection.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function CommandFileArtifactCard({ artifact }: { artifact: CommandFileArtifact }) {
  const downloadUrl = commandArtifactContentUrl(
    artifact.artifactId,
    artifact.version,
    { download: true },
  );
  const typeLabel = artifact.kind === "presentation"
    ? "PowerPoint presentation"
    : artifact.kind === "spreadsheet"
      ? "Excel workbook"
      : artifact.kind === "pdf"
        ? "PDF document"
        : "Word document";
  const detail = artifact.kind === "presentation" && artifact.slideCount
    ? `${artifact.slideCount} ${artifact.slideCount === 1 ? "slide" : "slides"}`
    : formatMediaBytes(artifact.byteCount);

  return (
    <section
      className="group overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      aria-label={`${typeLabel}: ${artifact.filename}`}
    >
      <div className="grid min-h-52 bg-[radial-gradient(circle_at_72%_18%,color-mix(in_srgb,var(--color-primary)_18%,transparent),transparent_38%),linear-gradient(135deg,var(--color-foreground),color-mix(in_srgb,var(--color-foreground)_88%,var(--color-primary)))] px-5 py-6 text-background sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-8 sm:px-7">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full border border-background/15 bg-background/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-background/75 backdrop-blur">
            <FileText size={13} aria-hidden="true" />
            Created by Asael
          </span>
          <h3 className="mt-5 max-w-xl text-balance text-2xl font-semibold tracking-tight text-background">
            {artifact.title}
          </h3>
          <p className="mt-3 text-sm leading-6 text-background/70">
            {typeLabel} · {detail} · Editable · Private
          </p>
        </div>
        <div className="relative mx-auto mt-7 h-28 w-48 sm:mt-0" aria-hidden="true">
          <span className="absolute inset-x-4 bottom-0 top-5 rotate-6 rounded-lg border border-background/20 bg-background/10 shadow-2xl" />
          <span className="absolute inset-x-2 bottom-2 top-3 -rotate-3 rounded-lg border border-background/25 bg-background/15 shadow-2xl" />
          <span className="absolute inset-0 grid rounded-lg border border-background/30 bg-background/95 p-3 text-foreground shadow-2xl transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-1">
            <span className="h-1.5 w-10 rounded-full bg-primary/75" />
            <span className="mt-2 h-2 w-4/5 rounded-full bg-foreground/80" />
            <span className="mt-1 h-1 w-3/5 rounded-full bg-foreground/20" />
            <span className="mt-auto grid grid-cols-3 gap-1.5">
              <span className="h-7 rounded bg-primary/20" />
              <span className="h-7 rounded bg-foreground/10" />
              <span className="h-7 rounded bg-primary/10" />
            </span>
          </span>
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/70 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{artifact.filename}</p>
          <p className="mt-0.5 text-xs text-muted">
            Version {artifact.version} · {formatMediaBytes(artifact.byteCount)} · Ready
          </p>
        </div>
        <a href={downloadUrl} className="action-button">
          <Download size={14} aria-hidden="true" />
          Download
        </a>
      </footer>
    </section>
  );
}

function CommandWorkspaceArtifactCard({
  artifact,
}: {
  artifact: CommandWorkspaceArtifact;
}) {
  const openUrl = commandWorkspaceArtifactUrl(artifact.kind, artifact.resourceId);
  const typeLabel = artifact.kind === "document"
    ? "Google Doc"
    : artifact.kind === "spreadsheet"
      ? "Google Sheet"
      : "Google Slides";
  const description = artifact.kind === "document"
    ? "Collaborative document"
    : artifact.kind === "spreadsheet"
      ? "Collaborative spreadsheet"
      : "Collaborative presentation";

  return (
    <section
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
      aria-label={`${typeLabel}: ${artifact.title}`}
    >
      <div className="relative flex-1 overflow-hidden px-5 pb-5 pt-4">
        <span
          className="pointer-events-none absolute -right-8 -top-12 size-36 rounded-full bg-primary/10 blur-2xl transition-transform duration-300 group-hover:scale-125"
          aria-hidden="true"
        />
        <div className="relative flex items-start justify-between gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary shadow-sm">
            <FileText size={20} aria-hidden="true" />
          </span>
          <span className="rounded-full border border-line bg-background/80 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted backdrop-blur">
            Google Workspace
          </span>
        </div>
        <h3 className="relative mt-5 line-clamp-2 text-balance text-lg font-semibold tracking-tight">
          {artifact.title}
        </h3>
        <p className="relative mt-2 text-sm leading-6 text-muted">
          {typeLabel} · {description} · Saved to Drive
        </p>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/65 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
          Verified and ready
        </span>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="action-button"
          aria-label={`Open ${artifact.title} in ${typeLabel}`}
        >
          Open in Google
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </footer>
    </section>
  );
}

function CommandMediaArtifactCard({ artifact }: { artifact: CommandMediaArtifact }) {
  const [readiness, setReadiness] = useState<PrivateMediaReadiness>("preparing");
  const downloadUrl = readiness === "ready"
    ? privateCaptureAssetContentUrl(artifact.assetId, { download: true })
    : undefined;
  const Icon = artifact.kind === "image" ? ImageIcon : Film;
  const operationLabel = artifact.operation === "clip"
    ? "Clipped video"
    : artifact.operation === "edit"
      ? `Edited ${artifact.kind}`
      : `Generated ${artifact.kind}`;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" aria-label={`${operationLabel}: ${artifact.filename}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line/80 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{artifact.filename}</p>
            <p className="mt-0.5 text-xs text-muted">
              {operationLabel}
              {artifact.byteCount > 0 ? ` · ${formatMediaBytes(artifact.byteCount)}` : ""}
              {` · ${readiness === "ready" ? "Ready" : readiness === "failed" ? "Preview unavailable" : "Preparing"}`}
              {" · Private"}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-line bg-background px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
          {artifact.kind}
        </span>
      </header>
      <PrivateMediaPreview
        assetId={artifact.assetId}
        kind={artifact.kind}
        alt={`${operationLabel}: ${artifact.filename}`}
        className="min-h-64 rounded-none sm:min-h-80"
        mediaClassName="max-h-[34rem]"
        onReadinessChange={setReadiness}
      />
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 bg-background/70 px-4 py-3 sm:px-5">
        <p className="text-xs leading-5 text-muted">
          Stored in your private Capture library.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/capture#media-studio-title" className="action-button">
            <Sparkles size={14} aria-hidden="true" />
            Media Studio
          </Link>
          {downloadUrl ? (
            <a href={downloadUrl} className="action-button">
              <Download size={14} aria-hidden="true" />
              Download
            </a>
          ) : (
            <span className="action-button cursor-not-allowed opacity-50" aria-disabled="true">
              <Download size={14} aria-hidden="true" />
              Preparing
            </span>
          )}
        </div>
      </footer>
    </section>
  );
}

function MessageInline({
  text,
  citations,
}: {
  text: string;
  citations?: Map<string, { source: GroundingReport["sources"][number]; index: number }>;
}) {
  const pattern = /\*\*[^*]+\*\*|(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\)|\[(?:(?:memory|knowledge|graph|web):[^\]\s]+|(?:csm|evidence_unit)_[a-zA-Z0-9_-]+)\]/g;
  const tokens: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) tokens.push(text.slice(cursor, match.index));
    tokens.push(match[0]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) tokens.push(text.slice(cursor));
  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith("**") && token.endsWith("**")) {
          return <strong key={`${token}-${index}`} className="font-semibold text-foreground"><MessageInline text={token.slice(2, -2)} citations={citations} /></strong>;
        }
        const code = /^(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)$/.exec(token);
        if (code) {
          return <code key={`${token}-${index}`} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[0.88em] text-foreground">{code[2]}</code>;
        }
        const link = /^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)$/.exec(token);
        if (link) {
          const href = safeSourceUrl(link[2]);
          return href
            ? <a key={`${token}-${index}`} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-primary underline decoration-primary/35 underline-offset-4 hover:decoration-primary">{link[1]}</a>
            : link[1];
        }
        const citationId = /^\[((?:(?:memory|knowledge|graph|web):[^\]\s]+|(?:csm|evidence_unit)_[a-zA-Z0-9_-]+))\]$/.exec(token)?.[1];
        const citation = citationId ? citations?.get(citationId) : undefined;
        if (citation) {
          const sourceUrl = safeSourceUrl(citation.source.url);
          const marker = (
            <span
              className="inline-flex min-w-5 items-center justify-center rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 align-super font-mono text-xs font-semibold leading-none text-primary"
              title={citation.source.title}
            >
              {citation.index}
            </span>
          );
          return sourceUrl ? (
            <a
              key={`${token}-${index}`}
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Source ${citation.index}: ${citation.source.title}`}
              className="mx-0.5 inline-flex no-underline transition hover:-translate-y-px"
            >
              {marker}
            </a>
          ) : (
            <span key={`${token}-${index}`} aria-label={`Source ${citation.index}: ${citation.source.title}`} className="mx-0.5 inline-flex">
              {marker}
            </span>
          );
        }
        if (citationId) {
          return <span key={`${token}-${index}`} className="mx-0.5 inline-flex rounded-md border border-warning/25 bg-warning/5 px-1.5 py-0.5 align-super text-xs leading-none text-muted" title="Source details are unavailable for this reference. This marker does not verify the statement.">Source unavailable</span>;
        }
        return token;
      })}
    </>
  );
}

function messageBlockStarts(lines: string[], index: number) {
  const line = lines[index].trim();
  return (
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    line.startsWith(">") ||
    /^---+$/.test(line) ||
    Boolean(parseMarkdownTable(lines, index))
  );
}

export function ClaimEvidencePanel({
  content,
  claimEvidence,
  sources,
}: {
  content: string;
  claimEvidence: NonNullable<GroundingReport["claimEvidence"]>;
  sources: GroundingReport["sources"];
}) {
  const coverage = claimEvidence.coverage;
  const citations = new Map(sources.map((source, index) => [source.citationId, { source, index: index + 1 }] as const));
  return (
    <details className="mt-3 rounded-xl border border-line/80 bg-background px-3">
      <summary className="flex min-h-10 cursor-pointer items-center justify-between gap-3 text-xs font-semibold">
        <span>Source review</span>
        <span className="text-muted">
          {coverage.materialClaimCount === 0 ? "No key statements to check"
            : coverage.coverageBps === 10_000 ? "Key statements supported" : "Sources need review"}
        </span>
      </summary>
      <p className="border-t border-line/70 pt-3 text-xs leading-5 text-muted">
        {coverage.supportedMaterialClaimCount} of {coverage.materialClaimCount} key statements have verified source support.
        Recommendations and paraphrases may still need review.
      </p>
      <ol className="max-h-96 space-y-2 overflow-y-auto border-t border-line/70 py-3">
        {claimEvidence.claims.map((claim) => {
          const claimText = content.slice(
            claim.startUtf16,
            claim.endUtf16Exclusive,
          );
          return (
            <li key={claim.claimId} className="rounded-lg bg-surface px-3 py-2.5 text-xs">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 leading-5 text-foreground"><MessageInline text={claimText} citations={citations} /></p>
                <span className={clsx(
                  "shrink-0 rounded-full px-2 py-1 text-xs font-semibold uppercase tracking-wide",
                  claimSupportTone(claim.supportState),
                )}>
                  {claimSupportLabel(claim.supportState)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {claim.evidenceUnitIds.length
                  ? `${claim.evidenceUnitIds.length} authorized evidence ${claim.evidenceUnitIds.length === 1 ? "unit" : "units"}`
                  : "No authorized evidence established support"}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function claimSupportLabel(state: ClaimSupportState) {
  return state === "supported"
    ? "Supported"
    : state === "inferred"
      ? "Inferred"
      : state === "disputed"
        ? "Disputed"
        : state === "stale"
          ? "Stale"
          : "Needs checking";
}

function claimSupportTone(state: ClaimSupportState) {
  if (state === "supported") return "bg-success/10 text-success";
  if (state === "inferred") return "bg-primary/10 text-primary";
  if (state === "disputed") return "bg-danger/10 text-danger";
  if (state === "stale") return "bg-warning/10 text-warning";
  return "bg-surface-raised text-muted";
}

export function groundingLabel(grounding: GroundingReport) {
  const coverage = grounding.claimEvidence?.coverage;
  if (grounding.assessment?.sourceCoverage === "not_available" && grounding.status === "missing") return "Claim support not assessed";
  if (coverage) {
    if (coverage.materialClaimCount === 0) return "No key statements to verify";
    if (coverage.coverageBps === 10_000) return "Key statements supported";
    return "Sources need review";
  }
  if (grounding.status === "verified") return "Sources cited";
  if (grounding.status === "not_required") return "No citations required";
  if (grounding.status === "invalid") return "Sources need review";
  return "Sources needed";
}

export function renderSafeGroundingReport(value: unknown): GroundingReport | undefined {
  const record = asRecord(value);
  const status = stringValue(record.status);
  if (!["verified", "not_required", "missing", "invalid"].includes(status)) {
    return undefined;
  }
  const stringArray = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap((candidate) => {
        const source = asRecord(candidate);
        const citationId = stringValue(source.citationId);
        const kind = stringValue(source.kind);
        const title = stringValue(source.title);
        if (!citationId || !kind || !title) return [];
        const confidence = numberValue(source.confidence, Number.NaN);
        return [{
          citationId,
          kind,
          title,
          ...(Number.isFinite(confidence) ? { confidence } : {}),
          ...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
          ...(stringValue(source.snippet) ? { snippet: stringValue(source.snippet) } : {}),
          ...(stringValue(source.accessedAt) ? { accessedAt: stringValue(source.accessedAt) } : {}),
        }];
      })
    : [];
  const claimEvidenceRecord = asRecord(record.claimEvidence);
  const coverageRecord = asRecord(claimEvidenceRecord.coverage);
  const rawClaims = claimEvidenceRecord.claims;
  const claims = Array.isArray(rawClaims)
    ? rawClaims.flatMap((candidate) => {
        const claim = asRecord(candidate);
        const claimId = stringValue(claim.claimId);
        const materiality = stringValue(claim.materiality);
        const supportState = stringValue(claim.supportState);
        const startUtf16 = numberValue(claim.startUtf16, Number.NaN);
        const endUtf16Exclusive = numberValue(claim.endUtf16Exclusive, Number.NaN);
        if (
          !claimId ||
          !["material", "non_material"].includes(materiality) ||
          !["supported", "inferred", "disputed", "stale", "unsupported"].includes(supportState) ||
          !Number.isSafeInteger(startUtf16) ||
          !Number.isSafeInteger(endUtf16Exclusive) ||
          startUtf16 < 0 ||
          endUtf16Exclusive < startUtf16
        ) return [];
        return [{
          claimId,
          startUtf16,
          endUtf16Exclusive,
          materiality: materiality as "material" | "non_material",
          supportState: supportState as ClaimSupportState,
          supportReason: stringValue(claim.supportReason),
          evidenceUnitIds: stringArray(claim.evidenceUnitIds),
        }];
      })
    : [];
  const claimEvidenceMapId = stringValue(claimEvidenceRecord.claimEvidenceMapId);
  const materialClaimCount = numberValue(coverageRecord.materialClaimCount, Number.NaN);
  const supportedMaterialClaimCount = numberValue(coverageRecord.supportedMaterialClaimCount, Number.NaN);
  const coverageBpsValue = coverageRecord.coverageBps === null
    ? null
    : numberValue(coverageRecord.coverageBps, Number.NaN);
  const validClaimEvidence = claimEvidenceRecord.schemaVersion === 1 &&
    claimEvidenceMapId &&
    Number.isSafeInteger(materialClaimCount) &&
    Number.isSafeInteger(supportedMaterialClaimCount) &&
    (coverageBpsValue === null || Number.isSafeInteger(coverageBpsValue));
  return {
    status: status as GroundingReport["status"],
    ...(asRecord(record.assessment).sourceCoverage === "not_available" ? { assessment: { sourceCoverage: "not_available" as const } } : {}),
    citedIds: stringArray(record.citedIds),
    invalidIds: stringArray(record.invalidIds),
    sources,
    ...(validClaimEvidence ? {
      claimEvidence: {
        schemaVersion: 1,
        claimEvidenceMapId,
        evaluatedAt: stringValue(claimEvidenceRecord.evaluatedAt),
        coverage: {
          materialClaimCount,
          supportedMaterialClaimCount,
          coverageBps: coverageBpsValue,
        },
        claims,
      },
    } : {}),
  };
}

export function citedGroundingSources(grounding: GroundingReport) {
  const citedIds = new Set(Array.isArray(grounding.citedIds) ? grounding.citedIds : []);
  const sources = Array.isArray(grounding.sources) ? grounding.sources : [];
  return sources.filter((source, index, values) =>
    citedIds.has(source.citationId) &&
    values.findIndex((candidate) => candidate.citationId === source.citationId) === index);
}

export function safeSourceUrl(value?: string) {
  if (!value) return undefined;
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    if (value.startsWith("/") && !value.startsWith("//")) {
      const local = new URL(value, "https://asael.invalid");
      const appPage = local.pathname.startsWith("/app/");
      const privateFile = /^\/api\/capture\/assets\/[A-Za-z0-9_-]+$/.test(local.pathname) &&
        local.searchParams.get("content") === "1";
      return local.origin === "https://asael.invalid" && (appPage || privateFile)
        ? `${local.pathname}${local.search}${local.hash}` : undefined;
    }
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMediaBytes(byteCount: number) {
  const bounded = Math.max(0, byteCount);
  if (bounded < 1_024) return `${bounded} B`;
  if (bounded < 1_024 ** 2) return `${(bounded / 1_024).toFixed(1)} KB`;
  if (bounded < 1_024 ** 3) return `${(bounded / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bounded / 1_024 ** 3).toFixed(1)} GB`;
}
