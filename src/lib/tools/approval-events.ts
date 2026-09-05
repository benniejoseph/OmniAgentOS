import { createHash } from "node:crypto";
import { z } from "zod";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export const TOOL_APPROVAL_EVENT_SCHEMA_VERSION = 1 as const;

const opaqueIdSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const toolApprovalEventPayloadSchema = z.object({
  schemaVersion: z.literal(TOOL_APPROVAL_EVENT_SCHEMA_VERSION),
  executionId: opaqueIdSchema,
  toolId: opaqueIdSchema,
  decision: z.enum(["approved", "rejected"]),
  outcome: z.enum(["quorum_pending", "execution_claimed", "rejected"]),
  riskLevel: z.number().int().min(0).max(3),
  approvalCount: z.number().int().min(0).max(100),
  requiredApprovalCount: z.number().int().min(1).max(100),
  approvalFingerprintSha256: sha256Schema.nullable(),
  idempotencyKeySha256: sha256Schema,
}).strict();

export type ToolApprovalMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export function toolApprovalMutationFromRequest(
  request: Request,
  context: SecurityContext,
  input: { executionId: string; decision: "approve" | "reject" },
): ToolApprovalMutationContext {
  const supplied = request.headers.get("idempotency-key")?.trim();
  if (
    supplied &&
    (supplied.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(supplied))
  ) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  const requestId = request.headers.get("x-request-id")?.trim();
  const correlationId = requestId && requestId.length <= 240
    ? requestId
    : supplied || crypto.randomUUID();
  return {
    idempotencyKey: supplied || correlationId,
    executionScope: executionScopeFromSecurityContext(context, {
      executingPrincipalType: context.role === "system" ? "system" : "user",
      executingPrincipalId: context.actorId,
      correlationId,
      causationId: input.executionId,
      purpose: `tool.approval.${input.decision}`,
    }),
  };
}

export function toolApprovalEventId(input: {
  tenantId: string;
  executionId: string;
  decisionActorId: string;
  decision: "approved" | "rejected";
}) {
  return `tool_approval_event_${approvalSha256(input)}`;
}

export function approvalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
