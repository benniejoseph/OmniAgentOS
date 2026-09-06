import { z } from "zod";

import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import {
  memoryAccessBindingAllows,
} from "@/lib/memory/access-binding";
import { getActiveMemoriesByIds } from "@/lib/memory/store";
import type {
  MemoryGraphSearchResult,
  MemoryRecord,
  MemorySearchResult,
} from "@/lib/memory/types";
import {
  getCanonicalKnowledgeEvidenceByChunkIds,
  type CanonicalKnowledgeEvidence,
} from "@/lib/rag/store";
import type { KnowledgeSearchResult } from "@/lib/rag/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { CONTEXT_COMPILER_V2_PURPOSE_ID } from "@/lib/sources/purposes";

export const CONTEXT_COMPILER_V2_SCHEMA_VERSION = 2 as const;
export const CONTEXT_COMPILER_V2_VERSION_ID =
  "context-compiler:v2-shadow" as const;
export const CONTEXT_COMPILER_V2_POLICY_VERSION_ID =
  "context-policy:v2-shadow" as const;

// Context engine candidates are independently bounded to 60 memories,
// 60 knowledge chunks, and 24 graph neighborhoods.
const MAX_CANDIDATES = 144;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().trim().min(1).max(240);
const countSchema = z.number().int().min(0).max(10_000);

export const contextCompilerV2ItemClassSchema = z.enum([
  "canonical_evidence",
  "claim",
  "summary",
  "graph_neighborhood",
]);

export const contextCompilerV2AuthorizationReasonSchema = z.enum([
  "authorized",
  "access_binding_missing",
  "authorization_scope_missing",
  "tenant_mismatch",
  "actor_mismatch",
  "scope_mismatch",
  "grant_mismatch",
  "purpose_not_allowed",
  "inactive_claim",
  "temporal_invalid",
  "canonical_lineage_missing",
  "source_not_current",
  "source_deleted",
  "retention_expired",
  "observation_from_future",
  "graph_lineage_missing",
  "graph_backing_memory_missing",
  "graph_backing_memory_inactive",
]);

export const contextCompilerV2SelectionReasonSchema = z.enum([
  "authorized_ranked",
  "user_included",
  "user_excluded",
  "policy_excluded",
  "budget_excluded",
]);

const contextCompilerV2DecisionSchema = z.object({
  candidateRefSha256: sha256Schema,
  itemClass: contextCompilerV2ItemClassSchema,
  sourceRevisionRefSha256: sha256Schema.nullable(),
  authorizationState: z.enum(["authorized", "rejected"]),
  authorizationReason: contextCompilerV2AuthorizationReasonSchema,
  selectionReason: contextCompilerV2SelectionReasonSchema,
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  selectedByLegacy: z.boolean(),
  selectedByV2: z.boolean(),
}).strict();

const contextCompilerV2ShadowReceiptBaseSchema = z.object({
  schemaVersion: z.literal(CONTEXT_COMPILER_V2_SCHEMA_VERSION),
  receiptId: idSchema,
  runId: idSchema,
  tenantId: idSchema,
  mode: z.literal("shadow"),
  compilerVersionId: z.literal(CONTEXT_COMPILER_V2_VERSION_ID),
  policyVersionId: z.literal(CONTEXT_COMPILER_V2_POLICY_VERSION_ID),
  purposeId: z.literal(CONTEXT_COMPILER_V2_PURPOSE_ID),
  querySha256: sha256Schema,
  asOfTime: z.string().datetime({ offset: true }),
  candidateCount: countSchema,
  authorizedCandidateCount: countSchema,
  selectedCount: countSchema,
  rejectedCount: countSchema,
  legacySelectedCount: countSchema,
  matchedSelectionCount: countSchema,
  legacyOnlyCount: countSchema,
  v2OnlyCount: countSchema,
  comparisonState: z.enum(["matched", "diverged"]),
  explicitSelectionState: z.enum(["automatic", "selected", "empty"]),
  selectedContextSha256: sha256Schema,
  decisionRootSha256: sha256Schema,
  decisions: z.array(contextCompilerV2DecisionSchema).max(MAX_CANDIDATES),
}).strict();

export const contextCompilerV2ShadowReceiptSchema =
  contextCompilerV2ShadowReceiptBaseSchema.extend({
    receiptSha256: sha256Schema,
  }).strict();

export type ContextCompilerV2AuthorizationReason = z.infer<
  typeof contextCompilerV2AuthorizationReasonSchema
>;
export type ContextCompilerV2ItemClass = z.infer<
  typeof contextCompilerV2ItemClassSchema
>;
export type ContextCompilerV2ShadowReceipt = z.infer<
  typeof contextCompilerV2ShadowReceiptSchema
>;

export type ContextCompilerV2PreparedCandidate = Readonly<{
  evidenceId: string;
  itemClass: ContextCompilerV2ItemClass;
  sourceRevisionId: string | null;
  score: number;
  authorizationState: "authorized" | "rejected";
  authorizationReason: ContextCompilerV2AuthorizationReason;
}>;

export type ContextCompilerV2Shadow = Readonly<{
  selectedEvidenceIds: readonly string[];
  receipt: ContextCompilerV2ShadowReceipt;
}>;

export async function prepareContextCompilerV2Candidates(input: {
  executionScope: ExecutionScope;
  memoryAccessScope?: DatabaseMemoryAccessScope;
  memoryResults: readonly MemorySearchResult[];
  knowledgeResults: readonly KnowledgeSearchResult[];
  graphResults: readonly MemoryGraphSearchResult[];
  asOfTime?: string;
}): Promise<ContextCompilerV2PreparedCandidate[]> {
  const asOfTime = canonicalTimestamp(input.asOfTime || new Date().toISOString());
  const canonicalKnowledge = await getCanonicalKnowledgeEvidenceByChunkIds(
    input.knowledgeResults.map((result) => result.chunk.id),
    { tenantId: input.executionScope.tenantId },
  );
  const canonicalByChunkId = new Map(
    canonicalKnowledge.map((candidate) => [candidate.chunk.id, candidate]),
  );
  const graphBackingIds = graphMemoryIds(input.graphResults);
  const graphBackingMemories = input.memoryAccessScope && graphBackingIds.length
    ? await getActiveMemoriesByIds(graphBackingIds, {
        tenantId: input.executionScope.tenantId,
        accessScope: input.memoryAccessScope,
      })
    : [];
  const graphBackingById = new Map(
    graphBackingMemories.map((memory) => [memory.id, memory]),
  );

  return [
    ...input.memoryResults.map((result) => prepareMemoryCandidate(
      result,
      input.executionScope,
      input.memoryAccessScope,
      asOfTime,
    )),
    ...input.knowledgeResults.map((result) => prepareKnowledgeCandidate(
      result,
      canonicalByChunkId.get(result.chunk.id),
      input.executionScope,
      asOfTime,
    )),
    ...input.graphResults.map((result) => prepareGraphCandidate(
      result,
      input.executionScope,
      input.memoryAccessScope,
      graphBackingById,
      asOfTime,
    )),
  ].slice(0, MAX_CANDIDATES);
}

export function buildContextCompilerV2Shadow(input: {
  runId: string;
  tenantId: string;
  query: string;
  candidates: readonly ContextCompilerV2PreparedCandidate[];
  legacySelectedEvidenceIds: readonly string[];
  explicitEvidenceIds?: readonly string[];
  limit: number;
  asOfTime?: string;
}): ContextCompilerV2Shadow {
  const asOfTime = canonicalTimestamp(input.asOfTime || new Date().toISOString());
  const candidates = uniqueCandidates(input.candidates);
  const legacySelectedEvidenceIds = uniqueIds(input.legacySelectedEvidenceIds);
  const explicitEvidenceIds = input.explicitEvidenceIds === undefined
    ? undefined
    : uniqueIds(input.explicitEvidenceIds);
  const explicitSelectionState = explicitEvidenceIds === undefined
    ? "automatic" as const
    : explicitEvidenceIds.length
      ? "selected" as const
      : "empty" as const;
  const limit = Math.min(
    Math.max(Math.trunc(input.limit) || 1, explicitEvidenceIds?.length || 1),
    24,
  );
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.evidenceId, candidate]),
  );
  const authorized = candidates.filter(
    (candidate) => candidate.authorizationState === "authorized",
  );
  const selectedEvidenceIds = explicitEvidenceIds === undefined
    ? [...authorized]
        .sort(compareCandidates)
        .slice(0, limit)
        .map((candidate) => candidate.evidenceId)
    : explicitEvidenceIds
        .filter((id) => candidateById.get(id)?.authorizationState === "authorized")
        .slice(0, limit);
  const selectedSet = new Set(selectedEvidenceIds);
  const legacySelectedSet = new Set(legacySelectedEvidenceIds);
  const explicitSet = explicitEvidenceIds ? new Set(explicitEvidenceIds) : undefined;
  const decisions = candidates.map((candidate) => ({
    candidateRefSha256: candidateReferenceSha256(candidate.evidenceId),
    itemClass: candidate.itemClass,
    sourceRevisionRefSha256: candidate.sourceRevisionId
      ? sourceContractSha256({
          domain: "context-compiler-v2-source-revision",
          sourceRevisionId: candidate.sourceRevisionId,
        })
      : null,
    authorizationState: candidate.authorizationState,
    authorizationReason: candidate.authorizationReason,
    selectionReason: selectionReason({
      candidate,
      selected: selectedSet.has(candidate.evidenceId),
      explicitSelectionState,
      explicitSet,
    }),
    scoreBasisPoints: scoreBasisPoints(candidate.score),
    selectedByLegacy: legacySelectedSet.has(candidate.evidenceId),
    selectedByV2: selectedSet.has(candidate.evidenceId),
  }));
  const matchedSelectionCount = selectedEvidenceIds.filter((id) =>
    legacySelectedSet.has(id)
  ).length;
  const legacyOnlyCount = legacySelectedEvidenceIds.filter((id) =>
    !selectedSet.has(id)
  ).length;
  const v2OnlyCount = selectedEvidenceIds.filter((id) =>
    !legacySelectedSet.has(id)
  ).length;
  const unsigned = {
    schemaVersion: CONTEXT_COMPILER_V2_SCHEMA_VERSION,
    receiptId: `context_compiler_v2_${sourceContractSha256({
      runId: input.runId,
      querySha256: sourceContractSha256(input.query),
      asOfTime,
    }).slice(0, 48)}`,
    runId: input.runId,
    tenantId: input.tenantId,
    mode: "shadow" as const,
    compilerVersionId: CONTEXT_COMPILER_V2_VERSION_ID,
    policyVersionId: CONTEXT_COMPILER_V2_POLICY_VERSION_ID,
    purposeId: CONTEXT_COMPILER_V2_PURPOSE_ID,
    querySha256: sourceContractSha256(input.query),
    asOfTime,
    candidateCount: candidates.length,
    authorizedCandidateCount: authorized.length,
    selectedCount: selectedEvidenceIds.length,
    rejectedCount: candidates.length - selectedEvidenceIds.length,
    legacySelectedCount: legacySelectedEvidenceIds.length,
    matchedSelectionCount,
    legacyOnlyCount,
    v2OnlyCount,
    comparisonState:
      legacyOnlyCount === 0 && v2OnlyCount === 0
        ? "matched" as const
        : "diverged" as const,
    explicitSelectionState,
    selectedContextSha256: sourceContractSha256({
      domain: "context-compiler-v2-selected-context",
      evidenceIds: selectedEvidenceIds,
    }),
    decisionRootSha256: sourceContractSha256({
      domain: "context-compiler-v2-decisions",
      decisions,
    }),
    decisions,
  };
  const receipt = parseContextCompilerV2ShadowReceipt({
    ...unsigned,
    receiptSha256: sourceContractSha256(unsigned),
  });
  return Object.freeze({
    selectedEvidenceIds: Object.freeze(selectedEvidenceIds),
    receipt,
  });
}

export function parseContextCompilerV2ShadowReceipt(
  value: unknown,
): ContextCompilerV2ShadowReceipt {
  const receipt = contextCompilerV2ShadowReceiptSchema.parse(value);
  const { receiptSha256, ...unsigned } = receipt;
  if (sourceContractSha256(unsigned) !== receiptSha256) {
    throw new Error("Context Compiler v2 shadow receipt digest is invalid.");
  }
  const authorizedCandidateCount = receipt.decisions.filter(
    (decision) => decision.authorizationState === "authorized",
  ).length;
  const selectedCount = receipt.decisions.filter(
    (decision) => decision.selectedByV2,
  ).length;
  const matchedSelectionCount = receipt.decisions.filter(
    (decision) => decision.selectedByV2 && decision.selectedByLegacy,
  ).length;
  const legacySelectedCount = receipt.decisions.filter(
    (decision) => decision.selectedByLegacy,
  ).length;
  const legacyOnlyCount = receipt.decisions.filter(
    (decision) => decision.selectedByLegacy && !decision.selectedByV2,
  ).length;
  const v2OnlyCount = receipt.decisions.filter(
    (decision) => decision.selectedByV2 && !decision.selectedByLegacy,
  ).length;
  if (
    receipt.candidateCount !== receipt.decisions.length ||
    receipt.authorizedCandidateCount !== authorizedCandidateCount ||
    receipt.selectedCount !== selectedCount ||
    receipt.rejectedCount !== receipt.candidateCount - receipt.selectedCount ||
    receipt.legacySelectedCount !== legacySelectedCount ||
    receipt.matchedSelectionCount !== matchedSelectionCount ||
    receipt.legacyOnlyCount !== legacyOnlyCount ||
    receipt.v2OnlyCount !== v2OnlyCount ||
    receipt.decisionRootSha256 !== sourceContractSha256({
      domain: "context-compiler-v2-decisions",
      decisions: receipt.decisions,
    }) ||
    receipt.comparisonState !== (
      receipt.legacyOnlyCount === 0 && receipt.v2OnlyCount === 0
        ? "matched"
        : "diverged"
    )
  ) {
    throw new Error("Context Compiler v2 shadow receipt counts are invalid.");
  }
  return receipt;
}

function prepareMemoryCandidate(
  result: MemorySearchResult,
  executionScope: ExecutionScope,
  memoryAccessScope: DatabaseMemoryAccessScope | undefined,
  asOfTime: string,
): ContextCompilerV2PreparedCandidate {
  const record = result.record;
  const authorizationReason = authorizeMemory(
    record,
    executionScope,
    memoryAccessScope,
    asOfTime,
  );
  return Object.freeze({
    evidenceId: `memory:${record.id}`,
    itemClass: isSummaryMemory(record) ? "summary" : "claim",
    sourceRevisionId: null,
    score: result.score,
    authorizationState:
      authorizationReason === "authorized" ? "authorized" : "rejected",
    authorizationReason,
  });
}

function prepareKnowledgeCandidate(
  result: KnowledgeSearchResult,
  canonical: CanonicalKnowledgeEvidence | undefined,
  executionScope: ExecutionScope,
  asOfTime: string,
): ContextCompilerV2PreparedCandidate {
  const authorizationReason = authorizeKnowledge(
    canonical,
    executionScope,
    asOfTime,
  );
  return Object.freeze({
    evidenceId: `knowledge:${result.chunk.id}`,
    itemClass: "canonical_evidence",
    sourceRevisionId: canonical?.evidenceUnit.sourceRevisionId || null,
    score: result.score,
    authorizationState:
      authorizationReason === "authorized" ? "authorized" : "rejected",
    authorizationReason,
  });
}

function prepareGraphCandidate(
  result: MemoryGraphSearchResult,
  executionScope: ExecutionScope,
  memoryAccessScope: DatabaseMemoryAccessScope | undefined,
  graphBackingById: ReadonlyMap<string, MemoryRecord>,
  asOfTime: string,
): ContextCompilerV2PreparedCandidate {
  const authorizationReason = authorizeGraph(
    result,
    executionScope,
    memoryAccessScope,
    graphBackingById,
    asOfTime,
  );
  return Object.freeze({
    evidenceId: `graph:${result.node.id}`,
    itemClass: "graph_neighborhood",
    sourceRevisionId: null,
    score: result.score,
    authorizationState:
      authorizationReason === "authorized" ? "authorized" : "rejected",
    authorizationReason,
  });
}

function authorizeMemory(
  memory: MemoryRecord,
  executionScope: ExecutionScope,
  memoryAccessScope: DatabaseMemoryAccessScope | undefined,
  asOfTime: string,
): ContextCompilerV2AuthorizationReason {
  if (memory.claimStatus !== "active") return "inactive_claim";
  if (!temporalIntervalContains(memory, asOfTime)) return "temporal_invalid";
  if (!memory.accessBinding) return "access_binding_missing";
  if (!memoryAccessScope) return "authorization_scope_missing";
  if (memory.accessBinding.tenantId !== executionScope.tenantId) {
    return "tenant_mismatch";
  }
  return memoryAccessBindingAllows(memoryAccessScope, memory.accessBinding)
    ? "authorized"
    : "scope_mismatch";
}

function authorizeKnowledge(
  canonical: CanonicalKnowledgeEvidence | undefined,
  executionScope: ExecutionScope,
  asOfTime: string,
): ContextCompilerV2AuthorizationReason {
  if (!canonical) return "canonical_lineage_missing";
  const evidence = canonical.evidenceUnit;
  if (canonical.sourceState.operation === "delete") return "source_deleted";
  if (!canonical.sourceState.isCurrent) return "source_not_current";
  if (evidence.tenantId !== executionScope.tenantId) return "tenant_mismatch";
  if (evidence.ownerActorId !== executionScope.initiatingActorId) {
    return "actor_mismatch";
  }
  if (!matchesEvidenceScope(evidence, executionScope)) return "scope_mismatch";
  if (!evidence.allowedPurposeIds.includes(CONTEXT_COMPILER_V2_PURPOSE_ID)) {
    return "purpose_not_allowed";
  }
  const contextGrants = new Set(executionScope.contextGrantIds);
  if (evidence.permissionGrantIds.some((id) => !contextGrants.has(id))) {
    return "grant_mismatch";
  }
  if (
    evidence.retentionExpiresAt !== null &&
    evidence.retentionExpiresAt <= asOfTime
  ) {
    return "retention_expired";
  }
  if (evidence.capturedAt > asOfTime || evidence.extractedAt > asOfTime) {
    return "observation_from_future";
  }
  return "authorized";
}

function authorizeGraph(
  result: MemoryGraphSearchResult,
  executionScope: ExecutionScope,
  memoryAccessScope: DatabaseMemoryAccessScope | undefined,
  graphBackingById: ReadonlyMap<string, MemoryRecord>,
  asOfTime: string,
): ContextCompilerV2AuthorizationReason {
  const nodes = [result.node, ...result.neighborhood.map((item) => item.node)];
  if (nodes.some((node) => !node.accessBinding)) {
    return "access_binding_missing";
  }
  if (!memoryAccessScope) return "authorization_scope_missing";
  if (nodes.some((node) => node.tenantId !== executionScope.tenantId)) {
    return "tenant_mismatch";
  }
  if (nodes.some((node) =>
    !memoryAccessBindingAllows(memoryAccessScope, node.accessBinding!)
  )) {
    return "scope_mismatch";
  }
  const memoryIds = uniqueIds(nodes.flatMap((node) => node.memoryIds)).slice(0, 128);
  if (!memoryIds.length) return "graph_lineage_missing";
  for (const id of memoryIds) {
    const memory = graphBackingById.get(id);
    if (!memory) return "graph_backing_memory_missing";
    if (
      memory.claimStatus !== "active" ||
      !temporalIntervalContains(memory, asOfTime)
    ) {
      return "graph_backing_memory_inactive";
    }
  }
  return "authorized";
}

function graphMemoryIds(results: readonly MemoryGraphSearchResult[]) {
  return uniqueIds(results.flatMap((result) => [
    ...result.node.memoryIds,
    ...result.neighborhood.flatMap((item) => item.node.memoryIds),
  ])).slice(0, 128);
}

function matchesEvidenceScope(
  evidence: CanonicalKnowledgeEvidence["evidenceUnit"],
  scope: ExecutionScope,
) {
  return matchesNullableScope(evidence.workspaceId, scope.workspaceId) &&
    matchesNullableScope(evidence.projectId, scope.projectId) &&
    matchesNullableScope(evidence.missionId, scope.missionId);
}

function matchesNullableScope(left: string | null, right: string | null) {
  return left === null || left === right;
}

function temporalIntervalContains(memory: MemoryRecord, asOfTime: string) {
  return (!memory.validFrom || memory.validFrom <= asOfTime) &&
    (!memory.validTo || memory.validTo > asOfTime) &&
    !memory.forgottenAt;
}

function isSummaryMemory(memory: MemoryRecord) {
  return memory.source === "daily-brief" ||
    memory.tags.some((tag) => tag === "summary" || tag === "daily-brief");
}

function selectionReason(input: {
  candidate: ContextCompilerV2PreparedCandidate;
  selected: boolean;
  explicitSelectionState: "automatic" | "selected" | "empty";
  explicitSet?: ReadonlySet<string>;
}): z.infer<typeof contextCompilerV2SelectionReasonSchema> {
  if (input.candidate.authorizationState !== "authorized") {
    return "policy_excluded";
  }
  if (input.explicitSelectionState === "empty") return "user_excluded";
  if (
    input.explicitSelectionState === "selected" &&
    !input.explicitSet?.has(input.candidate.evidenceId)
  ) {
    return "user_excluded";
  }
  if (!input.selected) return "budget_excluded";
  return input.explicitSelectionState === "selected"
    ? "user_included"
    : "authorized_ranked";
}

function compareCandidates(
  left: ContextCompilerV2PreparedCandidate,
  right: ContextCompilerV2PreparedCandidate,
) {
  const scoreDifference = scoreBasisPoints(right.score) - scoreBasisPoints(left.score);
  return scoreDifference || left.evidenceId.localeCompare(right.evidenceId);
}

function uniqueCandidates(
  candidates: readonly ContextCompilerV2PreparedCandidate[],
) {
  const byId = new Map<string, ContextCompilerV2PreparedCandidate>();
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const evidenceId = candidate.evidenceId.trim();
    if (!evidenceId || byId.has(evidenceId)) continue;
    byId.set(evidenceId, Object.freeze({ ...candidate, evidenceId }));
  }
  return [...byId.values()];
}

function uniqueIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function scoreBasisPoints(score: number) {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0)) * 10_000);
}

function candidateReferenceSha256(evidenceId: string) {
  return sourceContractSha256({
    domain: "context-compiler-v2-candidate",
    evidenceId,
  });
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Context Compiler v2 time is invalid.");
  }
  return parsed.toISOString();
}
