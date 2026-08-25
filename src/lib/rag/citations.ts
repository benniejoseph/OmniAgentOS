import type { ContextEvidenceItem } from "@/lib/rag/types";

export type CitationSource = {
  citationId: string;
  evidenceId: string;
  kind: ContextEvidenceItem["kind"];
  title: string;
  confidence: number;
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

export function verifyResponseCitations(response: string, items: ContextEvidenceItem[]): GroundingReport {
  const sources = buildCitationSources(items);
  const available = new Set(sources.map((source) => source.citationId));
  const citedIds = Array.from(new Set(Array.from(
    response.matchAll(/\[((?:memory|knowledge|graph):[^\]\s]+)\]/g),
    (match) => match[1],
  )));
  const invalidIds = citedIds.filter((id) => !available.has(id));
  if (!sources.length) return { status: "not_required", citedIds, invalidIds, sources };
  if (invalidIds.length) return { status: "invalid", citedIds, invalidIds, sources };
  if (!citedIds.length) return { status: "missing", citedIds, invalidIds, sources };
  return { status: "verified", citedIds, invalidIds, sources };
}
