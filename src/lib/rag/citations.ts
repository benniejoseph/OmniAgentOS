import { createHash } from "node:crypto";
import type { ContextEvidenceItem } from "@/lib/rag/types";

export type CitationSource = {
  citationId: string;
  evidenceId: string;
  kind: ContextEvidenceItem["kind"] | "web";
  title: string;
  confidence?: number;
  url?: string;
  snippet?: string;
  accessedAt?: string;
};

export type GroundingReport = {
  status: "verified" | "not_required" | "missing" | "invalid";
  citedIds: string[];
  invalidIds: string[];
  sources: CitationSource[];
};

export function citationIdForEvidence(item: ContextEvidenceItem) {
  return `${item.kind}:${item.id}`;
}

export function buildCitationSources(items: ContextEvidenceItem[]): CitationSource[] {
  return items.map((item) => ({
    citationId: citationIdForEvidence(item), evidenceId: item.id, kind: item.kind,
    title: item.title, confidence: item.confidence,
  }));
}

export function citationIdForWebUrl(value: string) {
  const url = normalizePublicWebUrl(value);
  if (!url) return "";
  return `web:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

export function buildWebCitationSources(
  items: Array<{ title?: string; url: string; snippet?: string }>,
  accessedAt?: string,
): CitationSource[] {
  return items.flatMap((item) => {
    const url = normalizePublicWebUrl(item.url);
    const citationId = url ? citationIdForWebUrl(url) : "";
    if (!url || !citationId) return [];
    return [{
      citationId,
      evidenceId: url,
      kind: "web" as const,
      title: (item.title?.trim() || url).slice(0, 1_000),
      url,
      snippet: item.snippet?.trim().slice(0, 2_000) || undefined,
      accessedAt: accessedAt?.slice(0, 100),
    }];
  });
}

export function mergeCitationSources(...catalogs: CitationSource[][]) {
  const sources = new Map<string, CitationSource>();
  for (const source of catalogs.flat()) {
    if (!source.citationId || sources.has(source.citationId)) continue;
    sources.set(source.citationId, source);
  }
  return [...sources.values()];
}

export function verifyResponseCitations(
  response: string,
  items: ContextEvidenceItem[],
  additionalSources: CitationSource[] = [],
): GroundingReport {
  return verifyCitationSources(
    response,
    mergeCitationSources(buildCitationSources(items), additionalSources),
  );
}

export function verifyCitationSources(response: string, sources: CitationSource[]): GroundingReport {
  const available = new Set(sources.map((source) => source.citationId));
  const citedIds = Array.from(new Set(Array.from(
    response.matchAll(/\[((?:memory|knowledge|graph|web):[^\]\s]+)\]/g),
    (match) => match[1],
  )));
  const invalidIds = citedIds.filter((id) => !available.has(id));
  if (invalidIds.length) return { status: "invalid", citedIds, invalidIds, sources };
  if (!sources.length) return { status: "not_required", citedIds, invalidIds, sources };
  if (!citedIds.length) return { status: "missing", citedIds, invalidIds, sources };
  return { status: "verified", citedIds, invalidIds, sources };
}

function normalizePublicWebUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}
