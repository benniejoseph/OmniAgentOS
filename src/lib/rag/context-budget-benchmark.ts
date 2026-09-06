import {
  DEFAULT_DUPLICATE_TOKEN_SHARE_TARGET,
  allocateContextBudget,
  annotateContextEvidenceLineage,
  estimateContextTokens,
} from "@/lib/rag/context-budget";
import type { ContextEvidenceItem } from "@/lib/rag/types";

export const P45_CONTEXT_BUDGET_THRESHOLDS = Object.freeze({
  caseCount: 16,
  budgetComplianceRate: 1,
  duplicateShareComplianceRate: 1,
  lineageAccuracyRate: 1,
  priorityTierCoverageRate: 1,
  maximumAverageDuplicateTokenShare: 0.2,
});

export type P45ContextBudgetMetrics = Readonly<{
  caseCount: number;
  budgetComplianceRate: number;
  duplicateShareComplianceRate: number;
  lineageAccuracyRate: number;
  priorityTierCoverageRate: number;
  averageDuplicateTokenShare: number;
  averageBudgetUtilization: number;
}>;

const LANGUAGE_CONTENT = Object.freeze([
  ["Restore the database from the verified backup.", "Stop writes before starting the restore."],
  ["Restaure la base depuis la sauvegarde verifiee.", "Arretez les ecritures avant la restauration."],
  ["Restaure la base de datos desde la copia verificada.", "Detenga las escrituras antes de restaurar."],
  ["Restaure o banco usando o backup verificado.", "Pare as gravacoes antes da restauracao."],
  ["Stellen Sie die Datenbank aus der geprueften Sicherung wieder her.", "Stoppen Sie Schreibvorgaenge zuerst."],
  ["Ripristina il database dal backup verificato.", "Interrompi le scritture prima del ripristino."],
  ["Herstel de database vanuit de geverifieerde back-up.", "Stop schrijfbewerkingen voor herstel."],
  ["Przywroc baze danych ze sprawdzonej kopii.", "Zatrzymaj zapisy przed przywracaniem."],
] as const);

export function runP45ContextBudgetBenchmark(): P45ContextBudgetMetrics {
  const outcomes = Array.from({ length: 16 }, (_, index) => runCase(index));
  return Object.freeze({
    caseCount: outcomes.length,
    budgetComplianceRate: rate(outcomes, (item) => item.budgetCompliant),
    duplicateShareComplianceRate: rate(
      outcomes,
      (item) => item.duplicateShareCompliant,
    ),
    lineageAccuracyRate: rate(outcomes, (item) => item.lineageAccurate),
    priorityTierCoverageRate: rate(
      outcomes,
      (item) => item.priorityTiersCovered,
    ),
    averageDuplicateTokenShare: average(
      outcomes.map((item) => item.duplicateTokenShare),
    ),
    averageBudgetUtilization: average(
      outcomes.map((item) => item.budgetUtilization),
    ),
  });
}

export function p45ContextBudgetGatePasses(metrics: P45ContextBudgetMetrics) {
  return metrics.caseCount >= P45_CONTEXT_BUDGET_THRESHOLDS.caseCount &&
    metrics.budgetComplianceRate >=
      P45_CONTEXT_BUDGET_THRESHOLDS.budgetComplianceRate &&
    metrics.duplicateShareComplianceRate >=
      P45_CONTEXT_BUDGET_THRESHOLDS.duplicateShareComplianceRate &&
    metrics.lineageAccuracyRate >=
      P45_CONTEXT_BUDGET_THRESHOLDS.lineageAccuracyRate &&
    metrics.priorityTierCoverageRate >=
      P45_CONTEXT_BUDGET_THRESHOLDS.priorityTierCoverageRate &&
    metrics.averageDuplicateTokenShare <=
      P45_CONTEXT_BUDGET_THRESHOLDS.maximumAverageDuplicateTokenShare;
}

function runCase(index: number) {
  const [procedure, decision] = LANGUAGE_CONTENT[index % LANGUAGE_CONTENT.length];
  const suffix = `${index}`;
  const candidates = annotateContextEvidenceLineage([
    memory(`decision-${suffix}`, "decision", decision.repeat(5), [`turn:decision-${suffix}`]),
    memory(`procedure-${suffix}`, "procedure", procedure.repeat(6), [`turn:procedure-${suffix}`]),
    knowledge(`chunk-a-${suffix}`, `revision-${suffix}`, `document-${suffix}`, procedure.repeat(7)),
    knowledge(`chunk-b-${suffix}`, `revision-${suffix}`, `document-${suffix}`, `${procedure.repeat(6)} checksum`),
    memory(`derived-${suffix}`, "knowledge", `${procedure.repeat(5)} source note`, [`knowledge:document-${suffix}`]),
    memory(`episode-${suffix}`, "episode", `Historical attempt ${suffix}. `.repeat(12), [`turn:episode-${suffix}`]),
    graph(`graph-${suffix}`, `Dependency map ${suffix}. `.repeat(12)),
  ]);
  const taskLimit = 760 + (index % 4) * 120;
  const reserved = 220 + (index % 3) * 40;
  const modelRemaining = index % 5 === 0 ? taskLimit - 80 : taskLimit + 200;
  const allocation = allocateContextBudget({
    items: candidates,
    limits: {
      modelInputTokenLimit: reserved + modelRemaining,
      reservedModelTokens: reserved,
      taskContextTokenLimit: taskLimit,
      duplicateTokenShareTarget: DEFAULT_DUPLICATE_TOKEN_SHARE_TARGET,
    },
    render: (items) => [
      "Context Engine Profile",
      ...items.map((item) =>
        `[${item.kind}:${item.id}] tier=${item.contextTier}\n${item.content}`
      ),
      "Critical Evidence Recap",
    ].join("\n---\n"),
  });
  const lineageCounts = new Map<string, number>();
  for (const candidate of candidates) {
    lineageCounts.set(
      candidate.lineageRefSha256,
      (lineageCounts.get(candidate.lineageRefSha256) || 0) + 1,
    );
  }
  return {
    budgetCompliant:
      estimateContextTokens(allocation.contextBlock) <=
        allocation.receipt.effectiveTokenLimit &&
      allocation.receipt.withinBudget,
    duplicateShareCompliant:
      allocation.receipt.duplicateTokenShare <=
      allocation.receipt.duplicateTokenShareTarget,
    lineageAccurate:
      lineageCounts.size === 5 &&
      [...lineageCounts.values()].filter((count) => count === 3).length === 1,
    priorityTiersCovered:
      allocation.items.some((item) => item.contextTier === "critical") &&
      allocation.items.some((item) => item.contextTier === "procedural"),
    duplicateTokenShare: allocation.receipt.duplicateTokenShare,
    budgetUtilization: allocation.receipt.effectiveTokenLimit
      ? allocation.receipt.estimatedTokens /
        allocation.receipt.effectiveTokenLimit
      : 0,
  };
}

function memory(
  id: string,
  type: "decision" | "procedure" | "knowledge" | "episode",
  content: string,
  evidenceRefs: string[],
): ContextEvidenceItem {
  return {
    id,
    kind: "memory",
    sourceKey: `memory:${id}`,
    title: id,
    content,
    score: 0.9,
    utilityScore: 0.9,
    supportScore: 0.9,
    diversityScore: 1,
    freshnessScore: 0.8,
    confidence: 0.9,
    reasons: [],
    result: {
      score: 0.9,
      reasons: [],
      record: {
        id,
        type,
        title: id,
        content,
        tags: [],
        scope: "user",
        source: "p4.5-fixture",
        importance: 0.9,
        evidenceRefs,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
    },
  };
}

function knowledge(
  id: string,
  sourceRevisionId: string,
  documentId: string,
  content: string,
): ContextEvidenceItem {
  const timestamp = "2026-09-06T00:00:00.000Z";
  return {
    id,
    kind: "knowledge",
    sourceKey: `knowledge:${documentId}`,
    title: id,
    content,
    score: 0.85,
    utilityScore: 0.85,
    supportScore: 0.85,
    diversityScore: 1,
    freshnessScore: 0.8,
    confidence: 0.85,
    reasons: [],
    result: {
      score: 0.85,
      vectorScore: 0.85,
      lexicalScore: 0.85,
      recencyScore: 0.8,
      reasons: [],
      chunk: {
        id,
        documentId,
        sourceRevisionId,
        evidenceUnitId: `${sourceRevisionId}:${id}`,
        chunkIndex: id.includes("chunk-a") ? 0 : 1,
        title: id,
        content,
        tags: [],
        source: "p4.5-fixture",
        tokenEstimate: estimateContextTokens(content),
        characterCount: content.length,
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      document: {
        id: documentId,
        sourceRevisionId,
        title: documentId,
        source: "p4.5-fixture",
        sourceType: "text",
        tags: [],
        contentHash: "fixture",
        chunkCount: 2,
        totalCharacters: content.length,
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function graph(id: string, content: string): ContextEvidenceItem {
  const timestamp = "2026-09-06T00:00:00.000Z";
  return {
    id,
    kind: "graph",
    sourceKey: `graph:${id}`,
    title: id,
    content,
    score: 0.7,
    utilityScore: 0.7,
    supportScore: 0.7,
    diversityScore: 1,
    freshnessScore: 0.7,
    confidence: 0.7,
    reasons: [],
    result: {
      score: 0.7,
      communityId: id,
      reasons: [],
      neighborhood: [],
      node: {
        id,
        tenantId: "p4.5-fixture",
        kind: "concept",
        label: id,
        slug: id,
        aliases: [],
        summary: content,
        weight: 0.7,
        sourceCount: 1,
        memoryIds: [],
        traceIds: [],
        tags: [],
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function rate<T>(items: readonly T[], predicate: (item: T) => boolean) {
  return round(items.filter(predicate).length / Math.max(1, items.length));
}

function average(values: readonly number[]) {
  return round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
