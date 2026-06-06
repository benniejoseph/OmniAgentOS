import { hasOpenAIKey } from "@/lib/config";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getStorageBackend, getVectorStoreStatus, hasDatabaseUrl } from "@/lib/db/client";
import { getEvalStats } from "@/lib/evaluations/store";
import { getMemoryStats } from "@/lib/memory/store";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { getKnowledgeStats } from "@/lib/rag/store";
import { getRunStats } from "@/lib/runs/store";
import { getSecurityStats } from "@/lib/security/audit-store";
import { canPerform, resolveSecurityContext, rbacRules, secretVaultPolicy, securityErrorResponse } from "@/lib/security/context";
import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { getWorkflowStats } from "@/lib/workflows/store";

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
    knowledge: await getKnowledgeStats(),
    runs: await getRunStats(),
    toolExecutions: await getToolExecutionStats(),
    mcpConnectors: await getMcpConnectorStats(),
    openApiConnectors: await getOpenApiConnectorStats(),
    workflows: await getWorkflowStats(),
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
