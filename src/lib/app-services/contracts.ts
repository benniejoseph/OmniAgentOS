import { z } from "zod";
import { requirePermission } from "@/lib/security/context";
import {
  executionScopeFromSecurityContext,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  canonicalJsonSha256,
  idempotencyKeySha256,
} from "@/lib/tools/effect-receipt";

export const APP_SERVICE_BOUNDARY_VERSION =
  "p9.1-app-service-boundary:1" as const;
export const APP_SERVICE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type AppServiceAccessMode = "read" | "mutation";

export type AppServiceCaller = Readonly<{
  context: SecurityContext;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}>;

export type AppServiceOperationContract = Readonly<{
  operation: string;
  action: string;
  resourceType: string;
  accessMode: AppServiceAccessMode;
  eventContract: string;
}>;

export type AuthorizedAppServiceCall = Readonly<{
  caller: AppServiceCaller;
  contract: AppServiceOperationContract;
  authoritySha256: string;
  idempotencyKeySha256: string | null;
}>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const appServiceReceiptBodySchema = z.object({
  schemaVersion: z.literal(APP_SERVICE_RECEIPT_SCHEMA_VERSION),
  receiptKind: z.literal("app_service_receipt"),
  boundaryVersion: z.literal(APP_SERVICE_BOUNDARY_VERSION),
  operation: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(120),
  resourceType: z.string().trim().min(1).max(120),
  accessMode: z.enum(["read", "mutation"]),
  eventContract: z.string().trim().min(1).max(160),
  authoritySha256: sha256Schema,
  idempotencyKeySha256: sha256Schema.nullable(),
  outcomeSha256: sha256Schema,
  resourceCount: z.number().int().min(0).max(1_000_000),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const appServiceReceiptSchema = appServiceReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Application-service receipt digest does not match its body.",
    });
  }
});

export type AppServiceReceipt = z.infer<typeof appServiceReceiptSchema>;

export type AppServiceResult<T> = Readonly<{
  data: T;
  receipt: AppServiceReceipt;
}>;

export function createAppServiceCaller(input: {
  context: SecurityContext;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}): AppServiceCaller {
  const tenantId = requiredIdentity(input.context.tenantId, "tenant");
  const actorId = requiredIdentity(input.context.actorId, "actor");
  const executionScope = input.executionScope === undefined
    ? undefined
    : parsePersistedExecutionScope(input.executionScope);
  if (input.executionScope !== undefined && !executionScope) {
    throw new Error("Application service execution scope is invalid.");
  }
  if (executionScope) {
    if (executionScope.tenantId !== tenantId) {
      throw new Error(
        "Application service execution scope belongs to a different tenant.",
      );
    }
    if (executionScope.initiatingActorId !== actorId) {
      throw new Error(
        "Application service execution scope belongs to a different actor.",
      );
    }
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  return Object.freeze({
    context: Object.freeze({ ...input.context, tenantId, actorId }),
    ...(executionScope ? { executionScope } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export function createRequestMutationAppServiceCaller(
  request: Request,
  context: SecurityContext,
  input: {
    purpose: string;
    workspaceId?: string;
    projectId?: string;
    missionId?: string;
    causationId?: string;
  },
) {
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    request.headers.get("x-idempotency-key")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    `app_${crypto.randomUUID()}`;
  const correlationId =
    request.headers.get("x-request-id")?.trim() || idempotencyKey;
  return createAppServiceCaller({
    context,
    idempotencyKey,
    executionScope: executionScopeFromSecurityContext(context, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      missionId: input.missionId,
      causationId: input.causationId,
      correlationId,
      purpose: input.purpose,
    }),
  });
}

export function authorizeAppServiceCall(
  caller: AppServiceCaller,
  contract: AppServiceOperationContract,
): AuthorizedAppServiceCall {
  requirePermission(caller.context, contract.action);
  if (contract.accessMode === "mutation") {
    if (!caller.executionScope || !caller.executionScope.initiatingActorId) {
      throw new Error(
        `Application service mutation ${contract.operation} requires an exact execution scope.`,
      );
    }
    if (!caller.idempotencyKey) {
      throw new Error(
        `Application service mutation ${contract.operation} requires an idempotency key.`,
      );
    }
  }
  const authoritySha256 = canonicalJsonSha256({
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    role: caller.context.role,
    executionScope: caller.executionScope || null,
  });
  return Object.freeze({
    caller,
    contract,
    authoritySha256,
    idempotencyKeySha256: caller.idempotencyKey
      ? idempotencyKeySha256({
          tenantId: caller.context.tenantId,
          idempotencyKey: caller.idempotencyKey,
        })
      : null,
  });
}

export function completeAppServiceCall<T>(
  authorized: AuthorizedAppServiceCall,
  data: T,
  options: { resourceCount?: number; occurredAt?: string } = {},
): AppServiceResult<T> {
  const body = appServiceReceiptBodySchema.parse({
    schemaVersion: APP_SERVICE_RECEIPT_SCHEMA_VERSION,
    receiptKind: "app_service_receipt",
    boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    operation: authorized.contract.operation,
    action: authorized.contract.action,
    resourceType: authorized.contract.resourceType,
    accessMode: authorized.contract.accessMode,
    eventContract: authorized.contract.eventContract,
    authoritySha256: authorized.authoritySha256,
    idempotencyKeySha256: authorized.idempotencyKeySha256,
    outcomeSha256: canonicalJsonSha256(data),
    resourceCount: options.resourceCount ?? inferResourceCount(data),
    occurredAt: options.occurredAt || new Date().toISOString(),
  });
  return Object.freeze({
    data,
    receipt: appServiceReceiptSchema.parse({
      ...body,
      receiptSha256: canonicalJsonSha256(body),
    }),
  });
}

function normalizeIdempotencyKey(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(normalized)) {
    throw new Error(
      "Application service idempotency key must be an opaque identifier of 512 characters or fewer.",
    );
  }
  return normalized;
}

function requiredIdentity(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`Application service requires an authenticated ${label}.`);
  }
  return normalized;
}

function inferResourceCount(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const collections = Object.values(value as Record<string, unknown>)
      .filter(Array.isArray);
    if (collections.length === 1) return collections[0].length;
  }
  return value === null || value === undefined ? 0 : 1;
}
