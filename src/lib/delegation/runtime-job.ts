import { z } from "zod";

import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export const DELEGATION_EXECUTION_JOB_KIND =
  "delegation_execution_v2" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const delegationExecutionJobPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(DELEGATION_EXECUTION_JOB_KIND),
  actorId: idSchema,
  executionId: idSchema,
  runId: idSchema,
  agentId: idSchema,
  contractSha256: sha256Schema,
  contextCapsuleSha256: sha256Schema,
  runtimeAssignmentSha256: sha256Schema,
  executionScope: z.unknown(),
  queuedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  try {
    const scope = parsePersistedExecutionScope(value.executionScope);
    if (
      !scope ||
      scope.initiatingActorId !== value.actorId ||
      scope.executingPrincipalType !== "agent" ||
      scope.delegationId === null ||
      scope.correlationId.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionScope"],
        message: "Delegation job scope is incomplete.",
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      path: ["executionScope"],
      message: "Delegation job scope is invalid.",
    });
  }
});

export type DelegationExecutionJobPayload = Readonly<
  Omit<z.infer<typeof delegationExecutionJobPayloadSchema>, "executionScope"> & {
    executionScope: ExecutionScope;
  }
>;

export function parseDelegationExecutionJobPayload(
  value: unknown,
): DelegationExecutionJobPayload {
  const parsed = delegationExecutionJobPayloadSchema.parse(value);
  const executionScope = parsePersistedExecutionScope(parsed.executionScope);
  if (!executionScope) throw new Error("Delegation job scope is required.");
  return Object.freeze({ ...parsed, executionScope });
}

