import { unstable_cache } from "next/cache";
import { resolveCapability, searchCapabilities } from "@/lib/capabilities/catalog";
import {
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_REASONING_MODEL,
  GEMINI_FAST_MODEL,
  GEMINI_IMAGE_MODEL,
  hasAnthropicKey,
  hasGeminiKey,
  hasGoogleMediaKey,
  hasOpenAIKey,
} from "@/lib/config";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import {
  getStorageBackend,
  getVectorStoreStatus,
  hasDatabaseUrl,
  withDatabaseRequestScope,
} from "@/lib/db/client";
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
import { canPerform, requirePermission, resolveSecurityContext, rbacRules, secretVaultPolicy, securityErrorResponse } from "@/lib/security/context";
import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { getWorkflowPlanStats } from "@/lib/workflows/planner";
import { getWorkflowStats } from "@/lib/workflows/store";
import { getWorkflowTriggerStats } from "@/lib/workflows/triggers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const loadCachedSettingsCapabilities = unstable_cache(
  loadSettingsCapabilities,
  ["settings-capabilities-v1"],
  { revalidate: 15 },
);

const loadCachedFullCapabilities = unstable_cache(
  loadFullCapabilities,
  ["full-capabilities-v1"],
  { revalidate: 15 },
);

async function GETHandler(request: Request) {
  let securityContext;
  try {
    securityContext = await resolveSecurityContext(request);
    requirePermission(securityContext, "read");
  } catch (error) {
    return securityErrorResponse(error);
  }
  const canReadSecurity = canPerform(securityContext.role, "read.security");
  const searchParams = new URL(request.url).searchParams;
  const view = searchParams.get("view");

  if (view === "catalog") {
    return capabilityCatalogResponse(searchParams, securityContext.tenantId);
  }

  if (view === "settings") {
    return Response.json(
      await loadCachedSettingsCapabilities(securityContext.tenantId),
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const snapshot = await loadCachedFullCapabilities(
    securityContext.tenantId,
    canReadSecurity,
  );

  return Response.json({
    ...snapshot,
    security: {
      ...snapshot.security,
      context: securityContext,
    },
  }, { headers: { "cache-control": "private, no-store" } });
}

async function capabilityCatalogResponse(
  searchParams: URLSearchParams,
  tenantId: string,
) {
  const allowlist = parseCapabilityAllowlist(searchParams);
  const id = searchParams.get("id")?.trim();

  if (id) {
    const capability = await resolveCapability({ tenantId, id, allowlist });
    if (!capability) {
      return Response.json(
        { error: "Capability not found" },
        { status: 404, headers: privateNoStoreHeaders() },
      );
    }
    return Response.json(
      { capability },
      { headers: privateNoStoreHeaders() },
    );
  }

  const limitValue = searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  const result = await searchCapabilities({
    tenantId,
    query: searchParams.get("q") || searchParams.get("query") || undefined,
    limit,
    allowlist,
  });
  return Response.json(result, { headers: privateNoStoreHeaders() });
}

function parseCapabilityAllowlist(searchParams: URLSearchParams) {
  const values = [
    ...searchParams.getAll("allow"),
    ...searchParams.getAll("allowlist"),
  ];
  if (!values.length) {
    return undefined;
  }
  return values.flatMap((value) => value.split(","));
}

function privateNoStoreHeaders() {
  return { "cache-control": "private, no-store" };
}

async function loadSettingsCapabilities(tenantId: string) {
  const [vectorStore, memory, knowledge] = await Promise.all([
    getVectorStoreStatus(),
    getMemoryStats({ tenantId }),
    getKnowledgeStats({ tenantId }),
  ]);
  return settingsCapabilities({ vectorStore, memory, knowledge });
}

function settingsCapabilities({
  vectorStore,
  memory,
  knowledge,
}: {
  vectorStore: Awaited<ReturnType<typeof getVectorStoreStatus>>;
  memory: Awaited<ReturnType<typeof getMemoryStats>>;
  knowledge: Awaited<ReturnType<typeof getKnowledgeStats>>;
}) {
  return {
    openaiConfigured: hasOpenAIKey(),
    geminiConfigured: hasGeminiKey(),
    anthropicConfigured: hasAnthropicKey(),
    googleMediaConfigured: hasGoogleMediaKey(),
    googleModels: { fast: GEMINI_FAST_MODEL, image: GEMINI_IMAGE_MODEL },
    anthropicModels: {
      fast: ANTHROPIC_FAST_MODEL,
      reasoning: ANTHROPIC_REASONING_MODEL,
    },
    liveWebSearchConfigured: hasOpenAIKey(),
    databaseConfigured: hasDatabaseUrl(),
    storageBackend: getStorageBackend(),
    vectorStore,
    memory,
    knowledge,
  };
}

async function loadFullCapabilities(
  tenantId: string,
  canReadSecurity: boolean,
) {
  const [
    vectorStore,
    memory,
    memoryGraph,
    knowledge,
    contextEngine,
    runs,
    toolExecutions,
    mcpConnectors,
    openApiConnectors,
    workflows,
    workflowPlans,
    workflowPlanExecutions,
    workflowTriggers,
    operationJobs,
    health,
    incidents,
    alerts,
    observability,
    observabilitySlo,
    evaluations,
    securityStats,
  ] = await Promise.all([
    getVectorStoreStatus(),
    getMemoryStats({ tenantId }),
    getMemoryGraphStats({ tenantId }),
    getKnowledgeStats({ tenantId }),
    getContextEngineStats({ tenantId }),
    getRunStats({ tenantId }),
    getToolExecutionStats({ tenantId }),
    getMcpConnectorStats({ tenantId }),
    getOpenApiConnectorStats({ tenantId }),
    getWorkflowStats({ tenantId }),
    getWorkflowPlanStats({ tenantId }),
    getWorkflowPlanNodeExecutionStats({ tenantId }),
    getWorkflowTriggerStats({ tenantId }),
    getOperationJobStats({ tenantId }),
    getHealthStats({ tenantId }),
    getIncidentStats({ tenantId }),
    getAlertDeliveryStats({ tenantId }),
    getObservabilityStats({ tenantId }),
    getObservabilitySloSnapshot({ tenantId }),
    getEvalStats({ tenantId }),
    canReadSecurity ? getSecurityStats(tenantId) : Promise.resolve(undefined),
  ]);

  return {
    ...settingsCapabilities({ vectorStore, memory, knowledge }),
    memoryGraph,
    contextEngine,
    runs,
    toolExecutions,
    mcpConnectors,
    openApiConnectors,
    workflows,
    workflowPlans,
    workflowPlanExecutions,
    workflowTriggers,
    operationJobs,
    health,
    incidents,
    alerts,
    observability,
    observabilitySlo,
    evaluations,
    security: {
      stats: securityStats,
      policy: {
        rbacRules,
        secretVault: secretVaultPolicy(),
      },
    },
    registry: getCapabilityRegistry(),
  };
}
