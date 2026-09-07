import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { loadWorkspaceReadiness } from "@/lib/workspace/readiness";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

const workspaceSummaryInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(16),
  approvalLimit: z.number().int().min(1).max(25).default(12),
}).strict();

const workspaceReadinessInputSchema = z.object({}).strict();

export async function getWorkspaceSummaryService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceSummaryInputSchema>,
) {
  const value = workspaceSummaryInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workspaces.summary"),
  );
  const summary = await loadWorkspaceSummary({
    tenantId: caller.context.tenantId,
    role: caller.context.role,
    limit: value.limit,
    approvalLimit: value.approvalLimit,
  });
  return completeAppServiceCall(authorized, summary);
}

export async function getWorkspaceReadinessService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceReadinessInputSchema>,
) {
  workspaceReadinessInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workspaces.readiness"),
  );
  const readiness = await loadWorkspaceReadiness({
    tenantId: caller.context.tenantId,
    identityReady: true,
  });
  return completeAppServiceCall(authorized, readiness);
}
