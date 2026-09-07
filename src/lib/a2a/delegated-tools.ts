import { z } from "zod";

import {
  openDelegatedA2ATokenV1,
  type A2ADelegatedTokenEnvelopeV1,
} from "@/lib/a2a/delegated-token";
import {
  assertA2APeerRolloutActive,
  type A2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { claimExternalA2AToolCall } from "@/lib/a2a/safety-store";
import { getA2APeer } from "@/lib/a2a/store";
import { getDelegationTask } from "@/lib/delegation/store";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { redactSensitive } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { publicToolExecution } from "@/lib/tools/audit-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { executeGovernedTool } from "@/lib/tools/executor";

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

export const delegatedA2AToolRequestV1Schema = z.object({
  toolId: idSchema,
  input: z.record(z.string().min(1).max(160), z.unknown()).default({}),
  idempotencyKey: idSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.input), "utf8") > 256_000) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "The delegated tool input exceeds its byte boundary.",
    });
  }
});

export class A2ADelegatedToolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429 | 503,
    readonly code: string,
  ) {
    super(message);
    this.name = "A2ADelegatedToolError";
  }
}

export function authenticateDelegatedA2AToolRequest(request: Request) {
  const authorization = request.headers.get("authorization")?.trim();
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) {
    throw new A2ADelegatedToolError(
      "A delegated A2A tool token is required.",
      401,
      "unauthenticated",
    );
  }
  try {
    return openDelegatedA2ATokenV1(token);
  } catch {
    throw new A2ADelegatedToolError(
      "The delegated A2A tool token is invalid, expired, or revoked.",
      401,
      "unauthenticated",
    );
  }
}

export async function executeDelegatedA2AToolV1(input: {
  envelope: A2ADelegatedTokenEnvelopeV1;
  request: unknown;
  abortSignal?: AbortSignal;
}) {
  const request = delegatedA2AToolRequestV1Schema.parse(input.request);
  const envelope = input.envelope;
  const rollout = await loadActiveRollout(envelope);
  const task = await getDelegationTask({
    tenantId: envelope.principal.tenantId,
    ownerActorId: envelope.principal.initiatingActorId,
    taskId: envelope.internalTaskId,
  });
  assertCurrentAuthority(envelope, rollout, task, request.toolId);
  const rateLimit = await checkSharedRateLimit({
    key: `a2a-delegated-tool:${envelope.principal.tenantId}:${envelope.tokenId}`,
    limit: Math.max(1, Math.min(60, envelope.principal.governedToolIds.length * 10)),
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    throw new A2ADelegatedToolError(
      "The delegated tool request limit was reached.",
      429,
      "resource_exhausted",
    );
  }

  const context: SecurityContext = {
    tenantId: envelope.principal.tenantId,
    actorId: envelope.principal.initiatingActorId,
    role: "viewer",
    source: "service",
  };
  const executionScope = createExecutionScope({
    tenantId: envelope.principal.tenantId,
    initiatingActorId: envelope.principal.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: envelope.principal.principalId,
    workspaceId: envelope.workspaceId,
    projectId: envelope.projectId,
    missionId: envelope.missionId,
    delegationId: envelope.principal.delegationId,
    correlationId: `a2a-delegated:${envelope.tokenSha256}`,
    causationId: request.idempotencyKey,
    contextGrantIds: envelope.principal.contextGrantIds,
    capabilityGrantIds: envelope.principal.capabilityGrantIds,
    purpose: `a2a.delegated_tool.${request.toolId}`,
  });
  const safety = await claimExternalA2AToolCall({
    tenantId: envelope.principal.tenantId,
    ownerActorId: envelope.principal.initiatingActorId,
    internalTaskId: envelope.internalTaskId,
    toolId: request.toolId,
    idempotencyKey: request.idempotencyKey,
    executionScope,
  });
  const result = await executeGovernedTool({
    toolId: request.toolId,
    input: request.input,
    dryRun: false,
    approved: false,
    forceApproval: safety.state.reservation.forceMutationApproval,
    context,
    executionScope,
    idempotencyKey: `${envelope.tokenId}:${request.idempotencyKey}`,
    abortSignal: input.abortSignal,
  });
  return boundedPublicResult(result.record, rollout.maxOutputBytes);
}

async function loadActiveRollout(envelope: A2ADelegatedTokenEnvelopeV1) {
  let rollout: A2APeerRolloutV1;
  try {
    rollout = await getA2APeer({
      tenantId: envelope.principal.tenantId,
      ownerActorId: envelope.principal.initiatingActorId,
      rolloutId: envelope.rolloutId,
    });
  } catch {
    throw new A2ADelegatedToolError(
      "The delegated A2A peer authority is unavailable.",
      403,
      "authority_denied",
    );
  }
  try {
    return assertA2APeerRolloutActive({ rollout, direction: "outbound" });
  } catch {
    throw new A2ADelegatedToolError(
      "The delegated A2A peer authority is no longer active.",
      403,
      "authority_denied",
    );
  }
}

function assertCurrentAuthority(
  envelope: A2ADelegatedTokenEnvelopeV1,
  rollout: A2APeerRolloutV1,
  task: Awaited<ReturnType<typeof getDelegationTask>>,
  toolId: string,
) {
  if (
    rollout.rolloutSha256 !== envelope.rolloutSha256 ||
    rollout.peerId !== envelope.peerId ||
    task.tenantId !== envelope.principal.tenantId ||
    task.ownerActorId !== envelope.principal.initiatingActorId ||
    task.parentExecutionId !== envelope.parentExecutionId ||
    task.delegationId !== envelope.principal.delegationId ||
    task.delegatePrincipalId !== envelope.principal.principalId ||
    task.contractSha256 !== envelope.principal.delegationContractSha256 ||
    task.state !== "working"
  ) {
    throw new A2ADelegatedToolError(
      "The delegated A2A task authority is no longer active.",
      403,
      "authority_denied",
    );
  }
  if (!envelope.principal.governedToolIds.includes(toolId)) {
    throw new A2ADelegatedToolError(
      "The requested tool is outside the delegated authority.",
      403,
      "authority_denied",
    );
  }
}

function boundedPublicResult(
  record: Awaited<ReturnType<typeof executeGovernedTool>>["record"],
  maxBytes: number,
) {
  const publicRecord = publicToolExecution(record);
  const redactedReason = redactSensitive(publicRecord.reason);
  const response = {
    execution: {
      id: publicRecord.id,
      toolId: publicRecord.toolId,
      status: publicRecord.status,
      riskLevel: publicRecord.riskLevel,
      approvalRequired: publicRecord.approvalRequired,
      reason: typeof redactedReason === "string" ? redactedReason : undefined,
      output: redactSensitive(publicRecord.output),
      effectReceipt: publicRecord.effectReceipt,
      createdAt: publicRecord.createdAt,
      completedAt: publicRecord.completedAt,
    },
  };
  const boundary = Math.min(maxBytes, 2_000_000);
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= boundary) {
    return response;
  }
  return {
    execution: {
      id: publicRecord.id,
      toolId: publicRecord.toolId,
      status: publicRecord.status,
      riskLevel: publicRecord.riskLevel,
      approvalRequired: publicRecord.approvalRequired,
      outputOmitted: true,
      outputSha256: canonicalJsonSha256(publicRecord.output ?? null),
      effectReceipt: publicRecord.effectReceipt,
      createdAt: publicRecord.createdAt,
      completedAt: publicRecord.completedAt,
    },
  };
}
