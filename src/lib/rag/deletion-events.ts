import { createHash } from "node:crypto";
import { z } from "zod";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export const KNOWLEDGE_DELETION_EVENT_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const knowledgeDeletionEventPayloadSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_DELETION_EVENT_SCHEMA_VERSION),
  operation: z.literal("delete_source_prefix"),
  sourcePrefixSha256: sha256Schema,
  idempotencyKeySha256: sha256Schema,
}).strict();

export type KnowledgeDeletionMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export function knowledgeDeletionMutationFromRequest(
  request: Request,
  context: SecurityContext,
  sourcePrefix: string,
): KnowledgeDeletionMutationContext {
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
      correlationId,
      causationId: knowledgeDeletionTargetId(sourcePrefix),
      purpose: "knowledge.delete_source",
    }),
  };
}

export function knowledgeDeletionEventId(input: {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
}) {
  return `knowledge_deletion_event_${knowledgeDeletionSha256(input)}`;
}

export function knowledgeDeletionTargetId(sourcePrefix: string) {
  return `knowledge_source_${knowledgeDeletionSha256(sourcePrefix)}`;
}

export function knowledgeDeletionSha256(value: unknown) {
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
