import { hasOpenAIKey } from "@/lib/config";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getStorageBackend, getVectorStoreStatus, hasDatabaseUrl } from "@/lib/db/client";
import { getAlertDeliveryStats } from "@/lib/diagnostics/alerts";
import { getHealthStats } from "@/lib/diagnostics/health";
import { getIncidentStats } from "@/lib/diagnostics/incidents";
import { getEvalStats } from "@/lib/evaluations/store";
import { getMemoryGraphStats } from "@/lib/memory/graph";
import { getMemoryStats } from "@/lib/memory/store";
import { getObservabilitySloSnapshot } from "@/lib/observability/slo-monitor";
import { getObservabilityStats } from "@/lib/observability/store";
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
    memory: await getMemoryStats({ tenantId: securityContext.tenantId }),
    memoryGraph: await getMemoryGraphStats(),
    knowledge: await getKnowledgeStats({ tenantId: securityContext.tenantId }),
    contextEngine: await getContextEngineStats({ tenantId: securityContext.tenantId }),
    runs: await getRunStats({ tenantId: securityContext.tenantId }),
    toolExecutions: await getToolExecutionStats({ tenantId: securityContext.tenantId }),
    mcpConnectors: await getMcpConnectorStats({ tenantId: securityContext.tenantId }),
    openApiConnectors: await getOpenApiConnectorStats({ tenantId: securityContext.tenantId }),
    workflows: await getWorkflowStats({ tenantId: securityContext.tenantId }),
    workflowPlans: await getWorkflowPlanStats({ tenantId: securityContext.tenantId }),
    workflowPlanExecutions: await getWorkflowPlanNodeExecutionStats(),
    workflowTriggers: await getWorkflowTriggerStats(),
    operationJobs: await getOperationJobStats(),
    health: await getHealthStats(),
    incidents: await getIncidentStats(),
    alerts: await getAlertDeliveryStats(),
    observability: await getObservabilityStats({ tenantId: securityContext.tenantId }),
    observabilitySlo: await getObservabilitySloSnapshot({ tenantId: securityContext.tenantId }),
    evaluations: await getEvalStats({ tenantId: securityContext.tenantId }),
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
