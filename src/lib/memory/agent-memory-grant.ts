import { z } from "zod";

import type { MemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import type { MemoryRecord } from "@/lib/memory/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const AGENT_MEMORY_GRANT_VERSION = "agent-memory-grant:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().trim().min(1).max(240);

export const agentMemoryGrantArtifactV1Schema = z.object({
  version: z.literal(AGENT_MEMORY_GRANT_VERSION),
  grantId: idSchema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  sourceAgentId: idSchema,
  sourceMemoryId: idSchema,
  targetAgentId: idSchema,
  targetMemoryId: idSchema,
  purposeId: z.literal("memory.retrieve.v1"),
  sourceAccessScopeSha256: sha256Schema,
  sourceContentSha256: sha256Schema,
  targetAccessScopeSha256: sha256Schema,
  idempotencyKeySha256: sha256Schema,
  createdByActorId: idSchema,
  createdAt: z.string().datetime({ offset: true }),
  artifactSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { artifactSha256, ...body } = value;
  if (sourceContractSha256(body) !== artifactSha256) {
    context.addIssue({
      code: "custom",
      path: ["artifactSha256"],
      message: "Agent memory grant artifact digest is invalid.",
    });
  }
});

export type AgentMemoryGrantArtifactV1 = z.infer<
  typeof agentMemoryGrantArtifactV1Schema
>;

export function buildAgentMemoryGrantArtifactV1(input: {
  tenantId: string;
  ownerActorId: string;
  sourceAgentId: string;
  sourceMemory: MemoryRecord;
  targetAgentId: string;
  targetMemoryId: string;
  targetAccessBinding: MemoryAccessBindingV1;
  idempotencyKey: string;
  createdAt: string;
}): AgentMemoryGrantArtifactV1 {
  const sourceBinding = input.sourceMemory.accessBinding;
  if (
    sourceBinding?.visibility !== "agent_private" ||
    sourceBinding.tenantId !== input.tenantId ||
    sourceBinding.ownerActorId !== input.ownerActorId ||
    sourceBinding.ownerAgentId !== input.sourceAgentId ||
    input.targetAccessBinding.visibility !== "agent_private" ||
    input.targetAccessBinding.tenantId !== input.tenantId ||
    input.targetAccessBinding.ownerActorId !== input.ownerActorId ||
    input.targetAccessBinding.ownerAgentId !== input.targetAgentId
  ) {
    throw new Error("Agent memory grant coordinates are inconsistent.");
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 500) {
    throw new Error("Agent memory sharing requires a bounded idempotency key.");
  }
  const idempotencyKeySha256 = sourceContractSha256(idempotencyKey);
  const grantId = `agent-memory-grant:${sourceContractSha256({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    sourceAgentId: input.sourceAgentId,
    sourceMemoryId: input.sourceMemory.id,
    targetAgentId: input.targetAgentId,
    idempotencyKeySha256,
  })}`;
  const body = {
    version: AGENT_MEMORY_GRANT_VERSION,
    grantId,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    sourceAgentId: input.sourceAgentId,
    sourceMemoryId: input.sourceMemory.id,
    targetAgentId: input.targetAgentId,
    targetMemoryId: input.targetMemoryId,
    purposeId: "memory.retrieve.v1" as const,
    sourceAccessScopeSha256: sourceBinding.accessScopeSha256,
    sourceContentSha256: sourceContractSha256({
      title: input.sourceMemory.title,
      content: input.sourceMemory.content,
    }),
    targetAccessScopeSha256: input.targetAccessBinding.accessScopeSha256,
    idempotencyKeySha256,
    createdByActorId: input.ownerActorId,
    createdAt: new Date(input.createdAt).toISOString(),
  };
  return Object.freeze(agentMemoryGrantArtifactV1Schema.parse({
    ...body,
    artifactSha256: sourceContractSha256(body),
  }));
}

export function agentMemoryGrantTargetMemoryId(input: {
  tenantId: string;
  ownerActorId: string;
  sourceAgentId: string;
  sourceMemoryId: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return `agent_shared_${sourceContractSha256({
    ...input,
    idempotencyKeySha256: sourceContractSha256(input.idempotencyKey.trim()),
  }).slice(0, 48)}`;
}
