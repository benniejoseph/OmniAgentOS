import type { SecurityContext } from "@/lib/security/types";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type {
  SalesforceMutationAuthority,
  SalesforceReadAuthority,
} from "@/lib/customer-success/salesforce-store";

export async function resolveSalesforceRequestAccess(
  context: SecurityContext,
  input: {
    workspaceId?: string;
    mode: "read" | "write";
    correlationId: string;
    executionScope?: ExecutionScope;
    purpose?: string;
  },
) {
  const access = await requestSharedMemoryAccessFromSecurityContext(context, {
    scope: "workspace",
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    purposeId: input.mode === "write"
      ? MEMORY_PURPOSE_IDS.write
      : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `${input.mode === "write" ? "Manage" : "Read"} the workspace Salesforce connection.`,
  });
  if (input.mode === "write" && (!access.authority.canWrite ||
      access.authority.initiatingActorId !== access.actorBinding.canonicalActorId)) {
    throw new Error("Salesforce workspace write access is required.");
  }
  return Object.freeze({
    access,
    readAuthority: salesforceReadAuthority(context, access),
    mutationAuthority: input.mode === "write"
      ? salesforceMutationAuthority(
          context,
          access,
          input.correlationId,
          input.executionScope,
          input.purpose,
        )
      : undefined,
  });
}

function salesforceReadAuthority(
  context: SecurityContext,
  access: RequestSharedMemoryAccessV1,
): SalesforceReadAuthority {
  return {
    tenantId: context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
  };
}

function salesforceMutationAuthority(
  context: SecurityContext,
  access: RequestSharedMemoryAccessV1,
  correlationId: string,
  source?: ExecutionScope,
  purpose?: string,
): SalesforceMutationAuthority {
  const canonicalActorId = access.actorBinding.canonicalActorId;
  return {
    ...salesforceReadAuthority(context, access),
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: source?.executingPrincipalType || "user",
      executingPrincipalId: source && source.executingPrincipalType !== "user"
        ? source.executingPrincipalId
        : canonicalActorId,
      workspaceId: access.authority.workspaceId,
      correlationId,
      causationId: source?.causationId,
      delegationId: source?.delegationId,
      contextGrantIds: source?.contextGrantIds,
      capabilityGrantIds: source?.capabilityGrantIds,
      purpose: purpose || "customer.salesforce.read_sync",
    }),
  };
}

export function publicSalesforceWorkspaceContext(
  access: RequestSharedMemoryAccessV1,
) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}
