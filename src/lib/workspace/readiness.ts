import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { getEvalStats } from "@/lib/evaluations/store";
import { getMemoryStats } from "@/lib/memory/store";
import { getKnowledgeStats } from "@/lib/rag/store";
import { getRunStats } from "@/lib/runs/store";
import { getWorkflowStats } from "@/lib/workflows/store";
import { listOAuthGrantsForTenant } from "@/lib/connectors/oauth-store";
import { unstable_cache } from "next/cache";

export type WorkspaceReadinessChecks = {
  identity: boolean;
  knowledge: boolean;
  connector: boolean;
  firstRun: boolean;
  evaluation: boolean;
};

export type WorkspaceReadiness = {
  generatedAt: string;
  checks: WorkspaceReadinessChecks;
  completedCount: number;
  totalCount: 5;
  firstSuccessfulRun: boolean;
};

export type WorkspaceReadinessInput = {
  identityReady: boolean;
  memoryTotal: number;
  knowledgeTotal: number;
  activeMcpConnectors: number;
  activeOpenApiConnectors: number;
  activeOAuthConnectors: number;
  completedAgentRuns: number;
  completedWorkflows: number;
  evaluationTotal: number;
};

export type WorkspaceReadinessDependencies = {
  memoryTotal: (tenantId: string) => Promise<number>;
  knowledgeTotal: (tenantId: string) => Promise<number>;
  activeMcpConnectors: (tenantId: string) => Promise<number>;
  activeOpenApiConnectors: (tenantId: string) => Promise<number>;
  activeOAuthConnectors: (tenantId: string) => Promise<number>;
  completedAgentRuns: (tenantId: string) => Promise<number>;
  completedWorkflows: (tenantId: string) => Promise<number>;
  evaluationTotal: (tenantId: string) => Promise<number>;
};

const defaultDependencies: WorkspaceReadinessDependencies = {
  memoryTotal: async (tenantId) =>
    (await getMemoryStats({ tenantId })).total,
  knowledgeTotal: async (tenantId) =>
    (await getKnowledgeStats({ tenantId })).documents,
  activeMcpConnectors: async (tenantId) =>
    (await getMcpConnectorStats({ tenantId })).active,
  activeOpenApiConnectors: async (tenantId) =>
    (await getOpenApiConnectorStats({ tenantId })).active,
  activeOAuthConnectors: async (tenantId) =>
    (await listOAuthGrantsForTenant(tenantId)).length,
  completedAgentRuns: async (tenantId) =>
    (await getRunStats({ tenantId })).byStatus.completed || 0,
  completedWorkflows: async (tenantId) =>
    (await getWorkflowStats({ tenantId })).byStatus.completed || 0,
  evaluationTotal: async (tenantId) =>
    (await getEvalStats({ tenantId })).total,
};

export function calculateWorkspaceReadiness(
  input: WorkspaceReadinessInput,
): WorkspaceReadiness {
  const checks = {
    identity: input.identityReady,
    knowledge: input.memoryTotal + input.knowledgeTotal > 0,
    connector:
      input.activeMcpConnectors +
        input.activeOpenApiConnectors +
        input.activeOAuthConnectors >
      0,
    firstRun: input.completedAgentRuns + input.completedWorkflows > 0,
    evaluation: input.evaluationTotal > 0,
  };
  return {
    generatedAt: new Date().toISOString(),
    checks,
    completedCount: Object.values(checks).filter(Boolean).length,
    totalCount: 5,
    firstSuccessfulRun: checks.firstRun,
  };
}

export async function loadWorkspaceReadiness(
  {
    tenantId,
    identityReady,
  }: {
    tenantId: string;
    identityReady: boolean;
  },
  dependencies: WorkspaceReadinessDependencies = defaultDependencies,
): Promise<WorkspaceReadiness> {
  if (dependencies === defaultDependencies) {
    return loadCachedWorkspaceReadiness(tenantId, identityReady);
  }
  return loadWorkspaceReadinessSources(
    { tenantId, identityReady },
    dependencies,
  );
}

const loadCachedWorkspaceReadiness = unstable_cache(
  (tenantId: string, identityReady: boolean) =>
    loadWorkspaceReadinessSources(
      { tenantId, identityReady },
      defaultDependencies,
    ),
  ["workspace-readiness-v2"],
  { revalidate: 15 },
);

async function loadWorkspaceReadinessSources(
  {
    tenantId,
    identityReady,
  }: {
    tenantId: string;
    identityReady: boolean;
  },
  dependencies: WorkspaceReadinessDependencies,
): Promise<WorkspaceReadiness> {
  const [
    memoryTotal,
    knowledgeTotal,
    activeMcpConnectors,
    activeOpenApiConnectors,
    activeOAuthConnectors,
    completedAgentRuns,
    completedWorkflows,
    evaluationTotal,
  ] = await Promise.all([
    dependencies.memoryTotal(tenantId),
    dependencies.knowledgeTotal(tenantId),
    dependencies.activeMcpConnectors(tenantId),
    dependencies.activeOpenApiConnectors(tenantId),
    dependencies.activeOAuthConnectors(tenantId),
    dependencies.completedAgentRuns(tenantId),
    dependencies.completedWorkflows(tenantId),
    dependencies.evaluationTotal(tenantId),
  ]);

  return calculateWorkspaceReadiness({
    identityReady,
    memoryTotal,
    knowledgeTotal,
    activeMcpConnectors,
    activeOpenApiConnectors,
    activeOAuthConnectors,
    completedAgentRuns,
    completedWorkflows,
    evaluationTotal,
  });
}
