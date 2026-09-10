import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export function buildCaptureKnowledgeSupersessionEvent(input: {
  tenantId: string;
  sourceItemId: string;
  keepDocumentId: string;
  retiredDocumentCount: number;
  retiredMemoryCount: number;
  retiredAt: string;
  executionScope: unknown;
}) {
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope || executionScope.tenantId !== input.tenantId) {
    throw new Error(
      "Capture knowledge supersession event requires its tenant execution scope.",
    );
  }
  const payload = Object.freeze({
    schemaVersion: 1,
    sourceItemId: input.sourceItemId,
    currentDocumentId: input.keepDocumentId,
    retiredDocumentCount: input.retiredDocumentCount,
    retiredMemoryCount: input.retiredMemoryCount,
    retiredAt: input.retiredAt,
  });
  const receipt = Object.freeze({
    tenantId: input.tenantId,
    ...payload,
    executionScope,
  });
  return Object.freeze({
    id: `knowledge_supersession_${sourceContractSha256(receipt).slice(0, 48)}`,
    streamId: `source:${input.sourceItemId}`,
    type: "knowledge.source_generation_retired" as const,
    executionScope,
    payload,
  });
}
