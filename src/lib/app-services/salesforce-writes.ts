import type { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { executeSalesforceWrite } from "@/lib/customer-success/salesforce-adapter";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";
import {
  customerMutationId,
  type CustomerAccountRevision,
} from "@/lib/customer-success/contracts";
import {
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
  getCustomerAccount360,
  saveCustomerAccount,
  type CustomerAccountMutationAuthority,
  type CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import {
  getSalesforceWriteConfiguration,
  parseSalesforceRecordWriteInput,
  providerRecordIdSha256,
  salesforceWriteConfigurationInputSchema,
  salesforceWriteExpectedTargetStateSha256,
  salesforceWriteExternalKey,
  salesforceWriteOperationId,
  salesforceWriteToolMetadata,
  type SalesforceRecordWriteToolId,
} from "@/lib/customer-success/salesforce-write-contracts";
import {
  SalesforceConnectionConflictError,
  SalesforceConnectionNotFoundError,
  beginSalesforceWriteAttempt,
  getSalesforceAccountLinkByCustomerAccount,
  getSalesforceConnection,
  prepareSalesforceWriteOperation,
  settleSalesforceWriteOperation,
  type SalesforceWriteOperation,
} from "@/lib/customer-success/salesforce-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export class SalesforceWriteDeniedError extends Error {
  constructor(message = "Salesforce writes require the Account 360 owner and explicit activation.") {
    super(message);
    this.name = "SalesforceWriteDeniedError";
  }
}

export async function configureSalesforceWritesService(
  caller: AppServiceCaller,
  input: z.input<typeof salesforceWriteConfigurationInputSchema>,
) {
  const value = salesforceWriteConfigurationInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.salesforce.writes.configure"),
  );
  const access = await writeAccess(caller, value.workspaceId);
  const account = await exactOwnedAccount(
    caller,
    access.readAuthority,
    value.accountId,
    value.expectedAccountRevision,
  );
  if (value.enabled) {
    const configuration = getSalesforceWriteConfiguration();
    if (!configuration.configured) {
      throw new SalesforceWriteDeniedError(
        "Salesforce guarded writes are disabled until the reviewed provider External ID field is configured.",
      );
    }
    await exactConnectionAndLink(
      access.readAuthority,
      value.accountId,
      access.mutationAuthority!.canonicalActorId,
    );
  }
  const revised = await saveCustomerAccount({
    authority: customerMutationAuthority(caller, access.mutationAuthority!),
    accountId: account.accountId,
    mutationId: customerMutationId({
      accountId: account.accountId,
      idempotencyKey: caller.idempotencyKey!,
      operation: "salesforce.writes.configure",
    }),
    expectedRevision: value.expectedAccountRevision,
    name: account.name,
    lifecycle: account.lifecycle,
    organizationEntityId: account.organizationEntityId,
    accountOwner: account.accountOwner,
    crmPermissions: {
      ...account.crmPermissions,
      externalWriteState: value.enabled ? "approval_required" : "disabled",
    },
  });
  return completeAppServiceCall(authorized, {
    account: revised,
    salesforceWrites: {
      state: revised.crmPermissions.externalWriteState,
      providerReady: getSalesforceWriteConfiguration().configured,
      approvalRequired: true,
    },
  });
}

export async function executeSalesforceRecordWriteService(
  caller: AppServiceCaller,
  toolId: SalesforceRecordWriteToolId,
  input: unknown,
) {
  const result = await runSalesforceRecordWrite(caller, toolId, input, false);
  if (!result) {
    throw new SalesforceConnectionConflictError(
      "Salesforce write reconciliation did not reach a terminal state.",
    );
  }
  return result;
}

export function reconcileSalesforceRecordWriteService(
  caller: AppServiceCaller,
  toolId: SalesforceRecordWriteToolId,
  input: unknown,
) {
  return runSalesforceRecordWrite(caller, toolId, input, true);
}

async function runSalesforceRecordWrite(
  caller: AppServiceCaller,
  toolId: SalesforceRecordWriteToolId,
  input: unknown,
  reconcileOnly: boolean,
) {
  const value = parseSalesforceRecordWriteInput(toolId, input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract(toolId),
  );
  const access = await writeAccess(caller, value.workspaceId);
  const account = await exactOwnedAccount(
    caller,
    access.readAuthority,
    value.accountId,
    value.expectedAccountRevision,
  );
  if (account.crmPermissions.externalWriteState !== "approval_required" ||
      !account.crmPermissions.customerDataPurposeIds.includes("customer_success.crm_sync")) {
    throw new SalesforceWriteDeniedError();
  }
  const { connection, link } = await exactConnectionAndLink(
    access.readAuthority,
    value.accountId,
    access.mutationAuthority!.canonicalActorId,
  );
  const executionId = boundedExecutionId(caller.idempotencyKey!);
  const operationId = salesforceWriteOperationId(executionId);
  const metadata = salesforceWriteToolMetadata(toolId);
  const expectedTargetStateSha256 = salesforceWriteExpectedTargetStateSha256({
    toolId,
    value,
    executionId,
  });
  const operationInput = {
    authority: access.mutationAuthority!,
    connection,
    customerAccountId: value.accountId,
    operationId,
    toolExecutionId: executionId,
    toolId,
    objectType: metadata.objectType,
    action: metadata.action,
    providerRecordIdSha256: metadata.action === "update"
      ? providerRecordIdSha256(value.recordId || "")
      : null,
    providerIdempotencyKeySha256: metadata.action === "create"
      ? canonicalJsonSha256({
          provider: "salesforce",
          externalKey: salesforceWriteExternalKey(executionId),
        })
      : null,
    requestSha256: canonicalJsonSha256({
      contractVersion: "p10.11-salesforce-guarded-write:1",
      toolId,
      value,
      executionId,
    }),
    expectedTargetStateSha256,
  } as const;
  let operation = await prepareSalesforceWriteOperation(operationInput);
  if (operation.state !== "prepared") {
    return completeOperation(authorized, operation);
  }
  const attempted = await beginSalesforceWriteAttempt({
    authority: access.mutationAuthority!,
    connectionId: connection.connectionId,
    operationId,
  });
  if (!attempted) {
    operation = await prepareSalesforceWriteOperation(operationInput);
    if (operation.state !== "prepared") return completeOperation(authorized, operation);
    throw new SalesforceConnectionConflictError(
      "Salesforce write attempt changed concurrently.",
    );
  }
  const execution = await executeSalesforceWrite({
    connection,
    toolId,
    value,
    executionId,
    salesforceAccountId: link.salesforceAccountId,
    reconcileOnly,
  });
  if (execution.status === "retryable") return undefined;
  operation = await settleSalesforceWriteOperation({
    authority: access.mutationAuthority!,
    connectionId: connection.connectionId,
    commit: execution.commit,
  });
  return completeOperation(authorized, operation);
}

async function writeAccess(caller: AppServiceCaller, workspaceId?: string) {
  return resolveSalesforceRequestAccess(caller.context, {
    workspaceId,
    mode: "write",
    correlationId: caller.executionScope!.correlationId,
    executionScope: caller.executionScope,
    purpose: "customer.salesforce.guarded_write",
  });
}

async function exactOwnedAccount(
  caller: AppServiceCaller,
  authority: Parameters<typeof getSalesforceConnection>[0],
  accountId: string,
  expectedRevision: number,
): Promise<CustomerAccountRevision> {
  const account = await getCustomerAccount360(
    customerReadAuthority(caller, authority),
    accountId,
  );
  if (!account) throw new CustomerAccountNotFoundError();
  if (account.account.revision !== expectedRevision) {
    throw new CustomerAccountConflictError("Customer account changed. Refresh and try again.");
  }
  if (account.account.ownerActorId !== authority.canonicalActorId) {
    throw new SalesforceWriteDeniedError("Only the Account 360 owner can activate or execute Salesforce writes.");
  }
  return account.account;
}

async function exactConnectionAndLink(
  authority: Parameters<typeof getSalesforceConnection>[0],
  accountId: string,
  canonicalActorId: string,
) {
  const [connection, link] = await Promise.all([
    getSalesforceConnection(authority),
    getSalesforceAccountLinkByCustomerAccount(authority, accountId),
  ]);
  if (!connection || connection.connectionState !== "active") {
    throw new SalesforceConnectionNotFoundError();
  }
  if (connection.ownerActorId !== canonicalActorId) {
    throw new SalesforceWriteDeniedError(
      "Salesforce writes require the owner of the connected workspace authorization.",
    );
  }
  if (!link || link.connectionId !== connection.connectionId) {
    throw new SalesforceConnectionConflictError(
      "Account 360 must be linked to an exact Salesforce Account before writing.",
    );
  }
  return { connection, link };
}

function customerReadAuthority(
  caller: AppServiceCaller,
  authority: Parameters<typeof getSalesforceConnection>[0],
): CustomerAccountReadAuthority {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    readableActorIds: authority.readableActorIds,
    purposeId: "customer_success.account.read",
  };
}

function customerMutationAuthority(
  caller: AppServiceCaller,
  authority: NonNullable<Awaited<ReturnType<typeof writeAccess>>["mutationAuthority"]>,
): CustomerAccountMutationAuthority {
  return {
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    readableActorIds: authority.readableActorIds,
    purposeId: "customer_success.account.manage",
    idempotencyKey: caller.idempotencyKey!,
    executionScope: authority.executionScope,
  };
}

function boundedExecutionId(value: string) {
  const executionId = value.trim();
  if (!executionId || executionId.length > 240) {
    throw new Error("Salesforce tool execution identity must be 240 characters or fewer.");
  }
  return executionId;
}

function completeOperation(
  authorized: ReturnType<typeof authorizeAppServiceCall>,
  operation: SalesforceWriteOperation,
) {
  if (!operation.commit) {
    throw new SalesforceConnectionConflictError(
      "Terminal Salesforce write evidence is incomplete.",
    );
  }
  return completeAppServiceCall(authorized, {
    commit: operation.commit,
    operation: {
      operationId: operation.operationId,
      toolId: operation.toolId,
      objectType: operation.objectType,
      action: operation.action,
      customerAccountId: operation.customerAccountId,
      requestSha256: operation.requestSha256,
      expectedTargetStateSha256: operation.expectedTargetStateSha256,
      state: operation.state,
      attemptCount: operation.attemptCount,
      completedAt: operation.completedAt,
    },
  });
}
