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
  readCustomerHealthEvaluationAcceptance,
  submitCustomerHealthEvaluation,
  CustomerHealthEvaluationRefusedError,
} from "@/lib/customer-success/health-store";
import {
  CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT,
  customerHealthEvaluationRequestSchema,
  buildCustomerHealthEvaluationIntent,
} from "@/lib/customer-success/health-mutation-contracts";
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
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  nativeCustomerHealthEvaluationIdSchema,
  nativeCustomerHealthEvaluationReadQuerySchema,
  nativeCustomerHealthEvaluationReadResponseForScopeSchema,
  nativeCustomerHealthEvaluateResponseForScopeSchema,
} from "@/lib/mobile/customer-health-mutation-contracts";

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

export const customerHealthNativeEvaluateServiceInputSchema = customerHealthEvaluationRequestSchema.safeExtend({ accountId: accountIdSchema });
export const customerHealthEvaluationReadServiceInputSchema = nativeCustomerHealthEvaluationReadQuerySchema.extend({
  accountId: accountIdSchema, evaluationId: nativeCustomerHealthEvaluationIdSchema,
}).strict();

/** Native evaluation retains a compact exact acceptance, independently of live health projections. */
export async function evaluateCustomerHealthNativeService(
  caller: AppServiceCaller,
  input: z.input<typeof customerHealthNativeEvaluateServiceInputSchema>,
) {
  const { accountId, ...request } = customerHealthNativeEvaluateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.health.evaluate"));
  const canonicalActorId = nativeHealthCaller(caller, request.workspaceId, accountId);
  const access = await customerHealthAccess(caller, request.workspaceId, "write");
  requireNativeHealthAccess(access, canonicalActorId, request.workspaceId);
  requireCustomerWrite(access);
  const authority = { ...mutationAuthority(access, caller), readableActorIds: [canonicalActorId] };
  let evaluated: Awaited<ReturnType<typeof submitCustomerHealthEvaluation>>;
  try {
    evaluated = await submitCustomerHealthEvaluation({ authority, accountId, request });
  } catch (error) {
    if (error instanceof CustomerHealthEvaluationRefusedError) {
      const intent = buildCustomerHealthEvaluationIntent({ ...authority, accountId, request });
      if (error.evaluationId !== intent.evaluationId || error.requestSha256 !== canonicalJsonSha256(intent)) {
        throw new Error("Health refusal evidence did not match the exact submitted request.");
      }
    }
    throw error;
  }
  const result = completeAppServiceCall(authorized, {
    contract: CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT,
    context: publicCustomerContext(access), currentAccount: evaluated.currentAccount,
    acceptance: evaluated.acceptance, replayed: evaluated.replayed,
  }, { resourceCount: 1 });
  // This validation can fail after commit. The HTTP boundary must not turn it
  // into a no-admission claim; the original exact receipt remains recoverable.
  nativeCustomerHealthEvaluateResponseForScopeSchema({
    tenantId: caller.context.tenantId, workspaceId: request.workspaceId, canonicalActorId,
    requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope!, idempotencyKey: caller.idempotencyKey!, accountId, request,
  }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}

export async function readCustomerHealthEvaluationService(
  caller: AppServiceCaller,
  input: z.input<typeof customerHealthEvaluationReadServiceInputSchema>,
) {
  const value = customerHealthEvaluationReadServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.health.evaluations.show"));
  const canonicalActorId = nativeHealthCaller(caller);
  const access = await customerHealthAccess(caller, value.workspaceId, "read");
  requireNativeHealthAccess(access, canonicalActorId, value.workspaceId);
  const observed = await readCustomerHealthEvaluationAcceptance(
    { ...readAuthority(access, caller), readableActorIds: [canonicalActorId] },
    { accountId: value.accountId, evaluationId: value.evaluationId },
  );
  const result = completeAppServiceCall(authorized, {
    contract: CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT,
    context: publicCustomerContext(access), currentAccount: observed.currentAccount,
    acceptance: observed.acceptance,
  }, { resourceCount: observed.acceptance ? 1 : 0 });
  nativeCustomerHealthEvaluationReadResponseForScopeSchema({
    ...value, tenantId: caller.context.tenantId, canonicalActorId,
    requestActorId: caller.context.actorId, role: caller.context.role,
  }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}

function nativeHealthCaller(caller: AppServiceCaller, workspaceId?: string, accountId?: string) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical) throw new CustomerAccountWriteDeniedError();
  if (workspaceId !== undefined) {
    const scope = caller.executionScope;
    if (!scope || scope.tenantId !== caller.context.tenantId || scope.initiatingActorId !== caller.context.actorId ||
      scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== caller.context.actorId ||
      scope.workspaceId !== workspaceId || scope.projectId !== null || scope.missionId !== null ||
      scope.delegationId !== null || scope.contextGrantIds.length !== 0 || scope.capabilityGrantIds.length !== 0 ||
      scope.causationId !== accountId || scope.purpose !== "api.customer-health.evaluate") throw new CustomerAccountWriteDeniedError();
  } else if (caller.executionScope) {
    // Exact receipt reads are current user reads, never delegated execution.
    throw new CustomerAccountWriteDeniedError();
  }
  return canonical.actorId;
}

function requireNativeHealthAccess(access: RequestSharedMemoryAccessV1, canonicalActorId: string, workspaceId: string) {
  if (access.actorBinding.canonicalActorId !== canonicalActorId || access.authority.workspaceId !== workspaceId ||
    access.authority.initiatingActorId !== canonicalActorId) throw new CustomerAccountWriteDeniedError();
}

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
