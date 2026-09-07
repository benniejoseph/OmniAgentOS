import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  customerAccountId,
  customerCrmPermissionsSchema,
  customerFactId,
  customerFactOwnerSchema,
  customerFactSourceSchema,
  customerFactValueSchema,
  customerMutationId,
} from "@/lib/customer-success/contracts";
import {
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
  getCustomerAccount360,
  listCustomerAccounts,
  recordCustomerFact,
  saveCustomerAccount,
  type CustomerAccountMutationAuthority,
  type CustomerAccountReadAuthority,
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

const lifecycleSchema = z.enum([
  "prospect",
  "onboarding",
  "active",
  "at_risk",
  "churned",
  "archived",
]);

export const customerAccountListServiceInputSchema = workspaceSelectionSchema.extend({
  lifecycle: lifecycleSchema.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const customerAccountShowServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: z.string().regex(/^customer-account:[a-f0-9]{64}$/),
}).strict();

export const customerAccountCreateServiceInputSchema = workspaceSelectionSchema.extend({
  name: z.string().trim().min(1).max(240),
  lifecycle: lifecycleSchema.default("prospect"),
  organizationEntityId: z.string().trim().min(1).max(240).nullable().default(null),
  accountOwner: customerFactOwnerSchema,
  customerDataPurposeIds: customerCrmPermissionsSchema.shape.customerDataPurposeIds
    .default(["customer_success.account.manage", "customer_success.account.read"]),
}).strict();

export const customerAccountReviseServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: z.string().regex(/^customer-account:[a-f0-9]{64}$/),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(240).optional(),
  lifecycle: lifecycleSchema.optional(),
  organizationEntityId: z.string().trim().min(1).max(240).nullable().optional(),
  accountOwner: customerFactOwnerSchema.optional(),
  customerDataPurposeIds: customerCrmPermissionsSchema.shape.customerDataPurposeIds.optional(),
}).strict().refine(
  ({ accountId: _accountId, expectedRevision: _expectedRevision, workspaceId: _workspaceId, ...change }) =>
    Object.keys(change).length > 0,
  { message: "A customer account change is required." },
);

export const customerFactRecordServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: z.string().regex(/^customer-account:[a-f0-9]{64}$/),
  factId: z.string().regex(/^customer-fact:[a-f0-9]{64}$/).optional(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  factKey: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  state: z.enum(["active", "retracted"]).default("active"),
  value: customerFactValueSchema,
  source: customerFactSourceSchema,
  owner: customerFactOwnerSchema,
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }).nullable().default(null),
  staleAfter: z.string().datetime({ offset: true }).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.factId !== undefined) !== (value.expectedRevision !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["expectedRevision"],
      message: "Fact revisions require both factId and expectedRevision.",
    });
  }
  if (value.state === "retracted" && value.factId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "A new fact cannot begin retracted.",
    });
  }
});

export class CustomerAccountWriteDeniedError extends Error {
  constructor() {
    super("Customer account owner access is required.");
    this.name = "CustomerAccountWriteDeniedError";
  }
}

export async function listCustomerAccountsService(
  caller: AppServiceCaller,
  input: z.input<typeof customerAccountListServiceInputSchema>,
) {
  const value = customerAccountListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.list"),
  );
  const access = await customerAccess(caller, value.workspaceId, "read");
  const accounts = await listCustomerAccounts(readAuthority(access, caller), {
    limit: value.limit,
    lifecycle: value.lifecycle,
  });
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    accounts,
  }, { resourceCount: accounts.length });
}

export async function showCustomerAccountService(
  caller: AppServiceCaller,
  input: z.input<typeof customerAccountShowServiceInputSchema>,
) {
  const value = customerAccountShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.show"),
  );
  const access = await customerAccess(caller, value.workspaceId, "read");
  const account = await getCustomerAccount360(
    readAuthority(access, caller),
    value.accountId,
  );
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    account: account || null,
  }, { resourceCount: account ? 1 : 0 });
}

export async function createCustomerAccountService(
  caller: AppServiceCaller,
  input: z.input<typeof customerAccountCreateServiceInputSchema>,
) {
  const value = customerAccountCreateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.create"),
  );
  const access = await customerAccess(caller, value.workspaceId, "write");
  requireCustomerWrite(access);
  const authority = mutationAuthority(access, caller);
  const accountId = customerAccountId({
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    idempotencyKey: caller.idempotencyKey!,
  });
  const account = await saveCustomerAccount({
    authority,
    accountId,
    mutationId: customerMutationId({
      accountId,
      idempotencyKey: caller.idempotencyKey!,
      operation: "account.create",
    }),
    name: value.name,
    lifecycle: value.lifecycle,
    organizationEntityId: value.organizationEntityId,
    accountOwner: value.accountOwner,
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
      customerDataPurposeIds: value.customerDataPurposeIds,
    },
  });
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    account,
  });
}

export async function reviseCustomerAccountService(
  caller: AppServiceCaller,
  input: z.input<typeof customerAccountReviseServiceInputSchema>,
) {
  const value = customerAccountReviseServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.revise"),
  );
  const access = await customerAccess(caller, value.workspaceId, "write");
  requireCustomerWrite(access);
  const read = readAuthority(access, caller);
  const current = await getCustomerAccount360(read, value.accountId);
  if (!current) throw new CustomerAccountNotFoundError();
  if (current.account.revision !== value.expectedRevision) {
    throw new CustomerAccountConflictError("Customer account changed. Refresh and try again.");
  }
  const account = await saveCustomerAccount({
    authority: mutationAuthority(access, caller),
    accountId: value.accountId,
    mutationId: customerMutationId({
      accountId: value.accountId,
      idempotencyKey: caller.idempotencyKey!,
      operation: "account.revise",
    }),
    expectedRevision: value.expectedRevision,
    name: value.name ?? current.account.name,
    lifecycle: value.lifecycle ?? current.account.lifecycle,
    organizationEntityId: value.organizationEntityId === undefined
      ? current.account.organizationEntityId
      : value.organizationEntityId,
    accountOwner: value.accountOwner ?? current.account.accountOwner,
    crmPermissions: {
      ...current.account.crmPermissions,
      customerDataPurposeIds: value.customerDataPurposeIds ??
        current.account.crmPermissions.customerDataPurposeIds,
    },
  });
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    account,
  });
}

export async function recordCustomerFactService(
  caller: AppServiceCaller,
  input: z.input<typeof customerFactRecordServiceInputSchema>,
) {
  const value = customerFactRecordServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.facts.record"),
  );
  const access = await customerAccess(caller, value.workspaceId, "write");
  requireCustomerWrite(access);
  const factId = value.factId || customerFactId({
    accountId: value.accountId,
    idempotencyKey: caller.idempotencyKey!,
  });
  const fact = await recordCustomerFact({
    authority: mutationAuthority(access, caller),
    accountId: value.accountId,
    factId,
    mutationId: customerMutationId({
      accountId: value.accountId,
      idempotencyKey: caller.idempotencyKey!,
      operation: "fact.record",
    }),
    expectedRevision: value.expectedRevision,
    factKey: value.factKey,
    state: value.state,
    value: value.value,
    source: { ...value.source, ingestedAt: value.source.observedAt },
    owner: value.owner,
    confidenceBasisPoints: value.confidenceBasisPoints,
    validFrom: value.validFrom,
    validTo: value.validTo,
    staleAfter: value.staleAfter,
  });
  return completeAppServiceCall(authorized, {
    context: publicCustomerContext(access),
    fact,
  });
}

async function customerAccess(
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
    auditPurpose: `${mode === "write" ? "Manage" : "Read"} customer Account 360 data.`,
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
      purpose: "customer.account.manage",
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
