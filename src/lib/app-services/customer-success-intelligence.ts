import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  buildCustomerSuccessAccountIntelligence,
  buildCustomerSuccessPortfolio,
  type CustomerSuccessApprovalInput,
} from "@/lib/customer-success/intelligence";
import {
  loadCustomerSuccessAccountSourceSet,
  loadCustomerSuccessPortfolioSourceSets,
} from "@/lib/customer-success/intelligence-store";
import { CustomerAccountNotFoundError, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestSharedMemoryAccessFromSecurityContext } from "@/lib/memory/shared-context";
import { getApprovalQueue, type ApprovalQueueItem } from "@/lib/operations/queue";
import { canPerform } from "@/lib/security/context";

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);

export const customerSuccessPortfolioServiceInputSchema = workspaceSelectionSchema.extend({
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const customerSuccessIntelligenceServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  historyLimit: z.number().int().min(1).max(250).default(100),
  timelineLimit: z.number().int().min(1).max(250).default(100),
}).strict();

export async function showCustomerSuccessPortfolioService(
  caller: AppServiceCaller,
  input: z.input<typeof customerSuccessPortfolioServiceInputSchema>,
) {
  const value = customerSuccessPortfolioServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.portfolio.show"),
  );
  const access = await intelligenceAccess(caller, value.workspaceId);
  const authority = readAuthority(caller, access);
  const [sources, queue] = await Promise.all([
    loadCustomerSuccessPortfolioSourceSets(authority, { limit: value.limit }),
    approvalQueueForCaller(caller),
  ]);
  const generatedAt = new Date().toISOString();
  const intelligence = sources.map((source) =>
    buildCustomerSuccessAccountIntelligence({
      ...source,
      approvals: approvalsForSource(queue, source),
      generatedAt,
      timelineLimit: 1,
    })
  );
  const portfolio = buildCustomerSuccessPortfolio(intelligence, generatedAt);
  return completeAppServiceCall(authorized, {
    context: publicIntelligenceContext(access),
    portfolio,
  }, { resourceCount: portfolio.accounts.length });
}

export async function showCustomerSuccessIntelligenceService(
  caller: AppServiceCaller,
  input: z.input<typeof customerSuccessIntelligenceServiceInputSchema>,
) {
  const value = customerSuccessIntelligenceServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.intelligence.show"),
  );
  const access = await intelligenceAccess(caller, value.workspaceId);
  const [source, queue] = await Promise.all([
    loadCustomerSuccessAccountSourceSet(readAuthority(caller, access), value.accountId, {
      historyLimit: value.historyLimit,
    }),
    approvalQueueForCaller(caller),
  ]);
  if (!source) throw new CustomerAccountNotFoundError();
  const intelligence = buildCustomerSuccessAccountIntelligence({
    ...source,
    approvals: approvalsForSource(queue, source),
    timelineLimit: value.timelineLimit,
  });
  return completeAppServiceCall(authorized, {
    context: publicIntelligenceContext(access),
    intelligence,
  });
}

async function intelligenceAccess(caller: AppServiceCaller, workspaceId?: string) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "workspace",
    workspaceId,
    correlationId: caller.executionScope?.correlationId || crypto.randomUUID(),
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "Read customer-success portfolio intelligence.",
  });
}

function readAuthority(
  caller: AppServiceCaller,
  access: Awaited<ReturnType<typeof intelligenceAccess>>,
): CustomerAccountReadAuthority {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
    purposeId: "customer_success.account.read",
  };
}

function publicIntelligenceContext(
  access: Awaited<ReturnType<typeof intelligenceAccess>>,
) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}

async function approvalQueueForCaller(caller: AppServiceCaller) {
  if (!canPerform(caller.context.role, "manage.workflow")) return [];
  const queue = await getApprovalQueue(100, { tenantId: caller.context.tenantId });
  return queue.items.filter((item) => item.kind !== "slo_policy");
}

function approvalsForSource(
  queue: readonly ApprovalQueueItem[],
  source: Awaited<ReturnType<typeof loadCustomerSuccessAccountSourceSet>> extends infer T
    ? Exclude<T, undefined>
    : never,
): CustomerSuccessApprovalInput[] {
  const projectIds = new Set(source.workflowRuns.map((run) => run.projectId));
  const runIds = new Set(source.workflowRuns.map((run) => run.runId));
  const relatedIds = new Set([
    source.account360.account.accountId,
    source.account360.account.accountEntityId,
    source.account360.account.revisionId,
    source.account360.account.accountSha256,
    ...(source.account360.account.organizationEntityId
      ? [source.account360.account.organizationEntityId]
      : []),
    ...projectIds,
    ...runIds,
    ...source.workflowRuns.flatMap((run) =>
      run.projectTaskIds.map((item) => item.projectTaskId)
    ),
  ]);
  return queue.flatMap((item) => {
    if (item.kind === "slo_policy") return [];
    const values = primitiveStrings(item.input);
    if (![...values].some((value) => relatedIds.has(value))) return [];
    const projectId = [...values].find((value) => projectIds.has(value));
    const exactRunId = [...values].find((value) => runIds.has(value));
    return [{
      kind: item.kind,
      id: item.id,
      title: item.title,
      status: item.status,
      riskLevel: item.riskLevel,
      reason: item.reason,
      createdAt: item.createdAt,
      projectId,
      runId: exactRunId || (item.kind === "workflow" ? item.id : undefined),
    }];
  });
}

function primitiveStrings(value: unknown, depth = 0, result = new Set<string>()) {
  if (depth > 8 || result.size >= 500) return result;
  if (typeof value === "string") {
    result.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) primitiveStrings(item, depth + 1, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      primitiveStrings(item, depth + 1, result);
    }
  }
  return result;
}
