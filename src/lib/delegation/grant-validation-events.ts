import { z } from "zod";

import type { DelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import {
  appendScopedDomainEvent,
  listStreamEvents,
} from "@/lib/events/store";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_GRANT_VALIDATION_EVENT_TYPE =
  "delegation.grants.validated" as const;
export const DELEGATION_GRANT_VALIDATION_VERSION =
  "delegation-grant-validation:1" as const;

const grantValidationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_GRANT_VALIDATION_VERSION),
  executionId: z.string().trim().min(1).max(240),
  delegationId: z.string().trim().min(1).max(240),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["current", "changed"]),
  category: z.enum(["all_grants", "capability_binding"]),
  validatedAt: z.string().datetime({ offset: true }),
  contentIncluded: z.literal(false),
  grantsAuthority: z.literal(false),
}).strict();

export type DelegationGrantValidationV1 = Readonly<
  z.infer<typeof grantValidationPayloadSchema>
>;

export type DelegationGrantValidationProjectionV1 = Readonly<
  | {
      status: "not_checked";
      category: null;
      validatedAt: null;
    }
  | {
      status: "current" | "changed";
      category: "all_grants" | "capability_binding";
      validatedAt: string;
    }
>;

export async function appendDelegationGrantValidation(input: {
  execution: DelegationExecutionRecordV1;
  executionScope: ExecutionScope;
  status: "current" | "changed";
  validatedAt?: string;
}) {
  assertScope(input.execution, input.executionScope);
  const payload = grantValidationPayloadSchema.parse({
    schemaVersion: 1,
    version: DELEGATION_GRANT_VALIDATION_VERSION,
    executionId: input.execution.executionId,
    delegationId: input.execution.delegationId,
    contractSha256: input.execution.contractSha256,
    status: input.status,
    category: input.status === "current"
      ? "all_grants"
      : "capability_binding",
    validatedAt: input.validatedAt || new Date().toISOString(),
    contentIncluded: false,
    grantsAuthority: false,
  });
  return appendScopedDomainEvent({
    id: `delegation-grant-validation:${canonicalJsonSha256(payload)}`,
    streamId: grantValidationStreamId(input.execution.delegationId),
    type: DELEGATION_GRANT_VALIDATION_EVENT_TYPE,
    executionScope: deriveExecutionScope(input.executionScope, {
      causationId: `delegation-grants:${input.execution.executionId}`,
      purpose: "delegation.grants.validate.v1",
    }),
    payload,
  });
}

export async function getLatestDelegationGrantValidation(input: {
  tenantId: string;
  ownerActorId: string;
  executionId: string;
  delegationId: string;
  contractSha256: string;
}): Promise<DelegationGrantValidationProjectionV1> {
  const events = await listStreamEvents(
    grantValidationStreamId(input.delegationId),
    {
      tenantId: input.tenantId,
      actorId: input.ownerActorId,
      order: "desc",
      limit: 20,
    },
  );
  for (const event of events) {
    if (event.type !== DELEGATION_GRANT_VALIDATION_EVENT_TYPE) continue;
    const parsed = grantValidationPayloadSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.executionId !== input.executionId ||
      parsed.data.delegationId !== input.delegationId ||
      parsed.data.contractSha256 !== input.contractSha256
    ) continue;
    return Object.freeze({
      status: parsed.data.status,
      category: parsed.data.category,
      validatedAt: parsed.data.validatedAt,
    });
  }
  return Object.freeze({
    status: "not_checked",
    category: null,
    validatedAt: null,
  });
}

function grantValidationStreamId(delegationId: string) {
  const value = delegationId.trim();
  if (!value || value.length > 240) {
    throw new Error("Delegation validation requires an exact delegation ID.");
  }
  return `delegation-execution:${value}`;
}

function assertScope(
  execution: DelegationExecutionRecordV1,
  scope: ExecutionScope,
) {
  if (
    scope.tenantId !== execution.tenantId ||
    scope.initiatingActorId !== execution.ownerActorId ||
    scope.correlationId !== execution.rootExecutionId ||
    scope.delegationId !== execution.delegationId
  ) {
    throw new Error(
      "Delegation grant validation is outside the exact execution authority.",
    );
  }
}
