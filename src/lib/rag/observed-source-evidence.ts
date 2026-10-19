import { createHash } from "node:crypto";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import { buildEvidenceUnitV1 } from "@/lib/sources/contracts";
import { CLAIM_EVIDENCE_PURPOSE_ID } from "@/lib/sources/purposes";
import type { CitationSource } from "@/lib/rag/citations";
import type { CanonicalKnowledgeEvidence } from "@/lib/rag/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Evidence is reconstructed from an exact governed read, never a citation's
 * caller-supplied snippet. A source observation supports its captured content,
 * not the truth of arbitrary claims or the source's current state. */
export async function loadObservedSourceEvidence(input: {
  runId: string; executionScope: ExecutionScope; citationSources: readonly CitationSource[]; evaluatedAt: string;
}): Promise<CanonicalKnowledgeEvidence[]> {
  const sources = input.citationSources.filter(source => source.kind === "web" && source.toolExecutionId).slice(0, 24);
  if (!sources.length) return [];
  const records = await getToolExecutionsByIds(sources.map(source => source.toolExecutionId!), { tenantId: input.executionScope.tenantId });
  const result: CanonicalKnowledgeEvidence[] = [];
  for (const source of sources) {
    const record = records.find(record => record.id === source.toolExecutionId);
    if (!record || record.status !== "executed" || record.dryRun || record.riskLevel !== 0 ||
        record.tenantId !== input.executionScope.tenantId || record.actorId !== input.executionScope.initiatingActorId ||
        record.toolId !== "web.read" || !record.output || typeof record.output !== "object") continue;
    const binding = await getToolExecutionScopeBinding(record.id, { tenantId: input.executionScope.tenantId });
    const scope = binding?.executionScope;
    if (!scope || binding?.toolId !== record.toolId || scope.correlationId !== input.runId ||
        scope.tenantId !== input.executionScope.tenantId || scope.initiatingActorId !== input.executionScope.initiatingActorId ||
        scope.executingPrincipalId !== input.executionScope.executingPrincipalId ||
        scope.delegationId !== input.executionScope.delegationId ||
        scope.workspaceId !== input.executionScope.workspaceId || scope.projectId !== input.executionScope.projectId || scope.missionId !== input.executionScope.missionId) continue;
    const page = record.output as Record<string, unknown>;
    if (page.url !== source.url || page.citationId !== source.citationId || page.contentTrust !== "untrusted" ||
        typeof page.content !== "string" || !page.content.trim() || typeof page.fetchedAt !== "string") continue;
    const capturedAt = page.fetchedAt;
    const age = Date.parse(input.evaluatedAt) - Date.parse(capturedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 5 * 60_000) continue;
    const content = page.content, hash = digest(content), revision = `observed:${digest(record.id + hash)}`;
    const evidenceUnit = buildEvidenceUnitV1({
      tenantId: scope.tenantId, ownerActorId: scope.initiatingActorId!, workspaceId: scope.workspaceId,
      projectId: scope.projectId, missionId: scope.missionId,
      connectionId: "governed-public-web", visibility: "user_private", sensitivity: "public",
      permissionGrantIds: [`tool-receipt:${record.id}`], allowedPurposeIds: [CLAIM_EVIDENCE_PURPOSE_ID],
      retentionPolicyId: "ephemeral-observation-five-minutes", retentionExpiresAt: new Date(Date.parse(capturedAt) + 5 * 60_000).toISOString(),
      sourceItemId: `web:${digest(source.url!)}`, sourceRevisionId: revision, sourceKind: "webpage",
      providerItemKeySha256: digest(source.url!), evidenceContentSha256: hash, evidenceByteLength: Buffer.byteLength(content),
      locator: { kind: "text_span", offsetUnit: "utf16_code_unit", startOffset: 0, endOffsetExclusive: content.length, containerLength: content.length, containerSha256: hash },
      sourceCreatedAt: null, sourceUpdatedAt: null, capturedAt, extractedAt: capturedAt,
      extractorIdentity: { extractorId: "governed-web-read", extractorVersionId: "receipt-v1", extractorConfigSha256: digest("web.read:captured-content:v1"), modelVersionId: null },
    });
    result.push({ evidenceUnit, sourceState: { currentRevisionId: revision, operation: "upsert", isCurrent: true },
      chunk: { id: source.evidenceId, tenantId: scope.tenantId, documentId: revision, sourceRevisionId: revision,
        evidenceUnitId: evidenceUnit.evidenceUnitId, chunkIndex: 0, title: source.title, content, tags: [], source: source.url!,
        tokenEstimate: Math.ceil(content.length / 4), characterCount: content.length,
        metadata: { toolExecutionId: record.id, observationOnly: true }, createdAt: capturedAt, updatedAt: capturedAt } });
  }
  return result;
}
