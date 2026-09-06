import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { indexUserPrivateMemoryGraphRecords } from "@/lib/memory/graph";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { saveMemory } from "@/lib/memory/store";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";
import { redactSensitive } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export type ExplicitMemoryAssertion = Readonly<{
  content: string;
  type: MemoryType;
}>;

export function parseExplicitMemoryAssertion(
  message: string,
): ExplicitMemoryAssertion | undefined {
  const match = message.match(
    /^\s*(?:please\s+)?remember(?:\s+that)?(?:\s*[:,-]\s*|\s+)([\s\S]+?)\s*$/i,
  );
  const content = match?.[1]?.trim();
  if (!content || content.length > 40_000) return undefined;
  return Object.freeze({
    content,
    type: assertionMemoryType(content),
  });
}

export async function formExplicitUserAssertionMemory(input: {
  context: SecurityContext;
  requestId: string;
  threadId: string;
  turnId: string;
  message: string;
}) {
  const assertion = parseExplicitMemoryAssertion(input.message);
  if (!assertion) return undefined;
  const access = requestMemoryAccessFromSecurityContext(input.context, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "memory.user_assertion",
    correlationId: `memory_assertion_${input.requestId}`,
  });
  if (!access) {
    throw new Error(
      "Explicit memory requires an authenticated user session.",
    );
  }
  const safeContent = String(redactSensitive(assertion.content)).slice(
    0,
    40_000,
  );
  if (!safeContent.trim()) {
    throw new Error("Explicit memory was empty after safety filtering.");
  }
  const id = `user_assertion_${sourceContractSha256({
    tenantId: input.context.tenantId,
    ownerActorId: access.actorBinding.canonicalActorId,
    requestId: input.requestId,
  })}`;
  const accessBinding = buildUserPrivateMemoryAccessBindingV1({
    tenantId: input.context.tenantId,
    ownerActorId: access.actorBinding.canonicalActorId,
    originPurpose: "memory.user_assertion",
  });
  const record = await saveMemory({
    id,
    tenantId: input.context.tenantId,
    type: assertion.type,
    title: assertionTitle(assertion.type, safeContent),
    content: safeContent,
    tags: ["explicit-memory", "user-assertion"],
    scope: "user",
    source: "user-assertion",
    importance: 0.9,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefs: [
      `thread:${input.threadId}`,
      `turn:${input.turnId}`,
      `request:${input.requestId}`,
    ],
    accessBinding,
    databaseAccessScope: access.databaseAccessScope,
    executionScope: access.executionScope,
    formationOrigin: "user_assertion",
  });
  assertIdempotentFormation(record, {
    content: safeContent,
    claimStatus: "active",
    ownerActorId: access.actorBinding.canonicalActorId,
  });
  await indexUserPrivateMemoryGraphRecords(
    [record],
    "memory.user_assertion",
    {
      tenantId: input.context.tenantId,
      accessScope: access.databaseAccessScope,
    },
  );
  await projectExplicitMemoryEntities({
    memory: record,
    executionScope: access.executionScope,
  });
  return record;
}

export async function formAssistantInferenceCandidate(input: {
  context: SecurityContext;
  requestId: string;
  runId: string;
  threadId?: string;
  response: string;
}) {
  const safeResponse = String(redactSensitive(input.response)).trim().slice(
    0,
    24_000,
  );
  if (safeResponse.length < 280) return undefined;
  const access = requestMemoryAccessFromSecurityContext(input.context, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "memory.assistant_inference",
    correlationId: `memory_inference_${input.requestId}`,
  });
  if (!access) return undefined;
  const id = `assistant_inference_${sourceContractSha256({
    tenantId: input.context.tenantId,
    ownerActorId: access.actorBinding.canonicalActorId,
    runId: input.runId,
  })}`;
  const record = await saveMemory({
    id,
    tenantId: input.context.tenantId,
    type: "fact",
    title: `Assistant inference from run ${input.runId.slice(0, 16)}`,
    content: safeResponse,
    tags: ["assistant-inference", "needs-confirmation"],
    scope: "user",
    source: "assistant-inference",
    importance: 0.3,
    confidence: 0.35,
    claimStatus: "candidate",
    assertedBy: "agent",
    evidenceRefs: [
      `run:${input.runId}`,
      ...(input.threadId ? [`thread:${input.threadId}`] : []),
      `request:${input.requestId}`,
    ],
    accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: input.context.tenantId,
      ownerActorId: access.actorBinding.canonicalActorId,
      originPurpose: "memory.assistant_inference",
    }),
    databaseAccessScope: access.databaseAccessScope,
    executionScope: access.executionScope,
    formationOrigin: "assistant_inference",
  });
  assertIdempotentFormation(record, {
    content: safeResponse,
    claimStatus: "candidate",
    ownerActorId: access.actorBinding.canonicalActorId,
  });
  return record;
}

function assertionMemoryType(content: string): MemoryType {
  if (/^(?:to\s+|i\s+(?:need|must|should|plan)\s+to\s+)/i.test(content)) {
    return "task";
  }
  if (
    /^(?:i\s+(?:prefer|like|want)\b|my\s+preference\b|please\s+always\b)/i.test(
      content,
    )
  ) {
    return "preference";
  }
  return "fact";
}

function assertionTitle(type: MemoryType, content: string) {
  const compact = content.replace(/\s+/g, " ").trim().slice(0, 96);
  const label = type === "preference"
    ? "Remembered preference"
    : type === "task"
      ? "Remembered commitment"
      : "Remembered fact";
  return `${label}: ${compact}`.slice(0, 160);
}

function assertIdempotentFormation(
  record: MemoryRecord,
  expected: {
    content: string;
    claimStatus: "active" | "candidate";
    ownerActorId: string;
  },
) {
  if (
    record.content !== expected.content ||
    record.claimStatus !== expected.claimStatus ||
    record.accessBinding?.visibility !== "user_private" ||
    record.accessBinding.ownerActorId !== expected.ownerActorId
  ) {
    throw new Error(
      "Memory formation idempotency key is already bound to different evidence.",
    );
  }
}
