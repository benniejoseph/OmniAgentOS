import { hasOpenAIKey } from "@/lib/config";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getStorageBackend, getVectorStoreStatus, hasDatabaseUrl } from "@/lib/db/client";
import { getEvalStats } from "@/lib/evaluations/store";
import { getMemoryGraphStats } from "@/lib/memory/graph";
import { getMemoryStats } from "@/lib/memory/store";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { getContextEngineStats } from "@/lib/rag/context-engine";
import { getKnowledgeStats } from "@/lib/rag/store";
import { getRunStats } from "@/lib/runs/store";
import { getSecurityStats } from "@/lib/security/audit-store";
import { canPerform, resolveSecurityContext, rbacRules, secretVaultPolicy, securityErrorResponse } from "@/lib/security/context";
import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { getWorkflowPlanStats } from "@/lib/workflows/planner";
import { getWorkflowStats } from "@/lib/workflows/store";
import { getWorkflowTriggerStats } from "@/lib/workflows/triggers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let securityContext;
  try {
    securityContext = await resolveSecurityContext(request);
  } catch (error) {
    return securityErrorResponse(error);
  }
  const canReadSecurity = canPerform(securityContext.role, "read.security");

  return Response.json({
    openaiConfigured: hasOpenAIKey(),
    databaseConfigured: hasDatabaseUrl(),
    storageBackend: getStorageBackend(),
    vectorStore: await getVectorStoreStatus(),
    memory: await getMemoryStats(),
    memoryGraph: await getMemoryGraphStats(),
    knowledge: await getKnowledgeStats(),
    contextEngine: await getContextEngineStats(),
    runs: await getRunStats(),
    toolExecutions: await getToolExecutionStats(),
    mcpConnectors: await getMcpConnectorStats(),
    openApiConnectors: await getOpenApiConnectorStats(),
    workflows: await getWorkflowStats(),
    workflowPlans: await getWorkflowPlanStats(),
    workflowPlanExecutions: await getWorkflowPlanNodeExecutionStats(),
    workflowTriggers: await getWorkflowTriggerStats(),
    operationJobs: await getOperationJobStats(),
    evaluations: await getEvalStats(),
    security: {
      context: securityContext,
      stats: canReadSecurity ? await getSecurityStats(securityContext.tenantId) : undefined,
      policy: {
        rbacRules,
        secretVault: secretVaultPolicy(),
      },
    },
    registry: getCapabilityRegistry(),
  });
}
