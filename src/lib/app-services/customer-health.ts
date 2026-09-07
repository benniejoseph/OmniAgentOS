import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { CustomerAccountWriteDeniedError } from "@/lib/app-services/customer-accounts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  buildCustomerHealthSuggestion,
  buildDefaultCustomerHealthPolicy,
  customerHealthEvaluationId,
} from "@/lib/customer-success/health-contracts";
import {
  evaluateAndSaveCustomerHealth,
  getCurrentCustomerHealthScore,
  listCustomerHealthScoreHistory,
} from "@/lib/customer-success/health-store";
import type {
  CustomerAccountMutationAuthority,
  CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { createExecutionScope } from "@/lib/security/execution-scope";

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

export const customerHealthShowServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  historyLimit: z.number().int().min(1).max(100).default(20),
}).strict();

const modelSuggestionDraftSchema = z.object({
  suggestionKind: z.enum(["next_action", "factor_review", "input_gap"]),
  statement: z.string().trim().min(1).max(1_000),
  citedEvidence: z.array(z.object({
    factRevisionId: opaqueIdSchema,
    factSha256: sha256Schema,
  }).strict()).min(1).max(20),
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  origin: z.object({
    providerId: opaqueIdSchema,
    modelId: opaqueIdSchema,
    promptSha256: sha256Schema,
  }).strict(),
}).strict();

export const customerHealthEvaluateServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  expectedAccountRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedAccountSha256: sha256Schema,
  modelSuggestions: z.array(modelSuggestionDraftSchema).max(20).default([]),
}).strict();

export async function showCustomerHealthService(
  caller: AppServiceCaller,
  input: z.input<typeof customerHealthShowServiceInputSchema>,
) {
  const value = customerHealthShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.health.show"),
  );
  const access = await customerHealthAccess(caller, value.workspaceId, "read");
  const authority = readAuthority(access, caller);
  const [score, history] = await Promise.all([
    getCurrentCustomerHealthScore(authority, value.accountId),
    listCustomerHealthScoreHistory(authority, value.accountId, {
      limit: value.historyLimit,
    }),
  ]);
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    policy: buildDefaultCustomerHealthPolicy(),
    score: score || null,
    history,
  }, { resourceCount: score ? 1 : 0 });
}

export async function evaluateCustomerHealthService(
  caller: AppServiceCaller,
  input: z.input<typeof customerHealthEvaluateServiceInputSchema>,
) {
  const value = customerHealthEvaluateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.health.evaluate"),
  );
  const access = await customerHealthAccess(caller, value.workspaceId, "write");
  requireCustomerWrite(access);
  const createdAt = new Date().toISOString();
  const suggestions = value.modelSuggestions.map((suggestion) =>
    buildCustomerHealthSuggestion({
      suggestionKind: suggestion.suggestionKind,
      statement: suggestion.statement,
      citedFactRevisionIds: suggestion.citedEvidence.map((citation) =>
        citation.factRevisionId
      ),
      citedFactSha256s: suggestion.citedEvidence.map((citation) =>
        citation.factSha256
      ),
      confidenceBasisPoints: suggestion.confidenceBasisPoints,
      origin: {
        kind: "model",
        ...suggestion.origin,
      },
      createdAt,
    })
  );
  const score = await evaluateAndSaveCustomerHealth({
    authority: mutationAuthority(access, caller),
    accountId: value.accountId,
    expectedAccountRevision: value.expectedAccountRevision,
    expectedAccountSha256: value.expectedAccountSha256,
    evaluationId: customerHealthEvaluationId({
      accountId: value.accountId,
      idempotencyKey: caller.idempotencyKey!,
    }),
    suggestions,
  });
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    score,
  });
}

async function customerHealthAccess(
  caller: AppServiceCaller,
  workspaceId: string | undefined,
  mode: "read" | "write",
) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "workspace",
    workspaceId,
    correlationId:
      caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
    purposeId: mode === "write" ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `${mode === "write" ? "Evaluate" : "Read"} customer health evidence.`,
  });
}

function requireCustomerWrite(access: RequestSharedMemoryAccessV1) {
  if (!access.authority.canWrite ||
      access.authority.initiatingActorId !== access.actorBinding.canonicalActorId) {
    throw new CustomerAccountWriteDeniedError();
  }
}

function readAuthority(
  access: RequestSharedMemoryAccessV1,
  caller: AppServiceCaller,
): CustomerAccountReadAuthority {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
    purposeId: "customer_success.account.read",
  };
}

function mutationAuthority(
  access: RequestSharedMemoryAccessV1,
  caller: AppServiceCaller,
): CustomerAccountMutationAuthority {
  const source = caller.executionScope!;
  const canonicalActorId = access.actorBinding.canonicalActorId;
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
    purposeId: "customer_success.account.manage",
    idempotencyKey: caller.idempotencyKey!,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: source.executingPrincipalType,
      executingPrincipalId: source.executingPrincipalType === "user"
        ? canonicalActorId
        : source.executingPrincipalId,
      workspaceId: access.authority.workspaceId,
      correlationId: source.correlationId,
      causationId: source.causationId,
      delegationId: source.delegationId,
      contextGrantIds: source.contextGrantIds,
      capabilityGrantIds: source.capabilityGrantIds,
      purpose: "customer.health.evaluate",
    }),
  };
}

function publicCustomerContext(access: RequestSharedMemoryAccessV1) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}
