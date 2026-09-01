import { isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { getStorageBackend, hasDatabaseUrl } from "@/lib/db/client";
import { credentialVaultStatus } from "@/lib/settings/credential-vault";
import { listServiceApiKeys } from "@/lib/settings/service-api-keys";
import {
  getMcpExportConfiguration,
  listModelAssignments,
  listModelCatalog,
  listProviderConnections,
} from "@/lib/settings/store";
import type { SettingsSnapshot } from "@/lib/settings/types";

export async function getSettingsSnapshot(input: {
  tenantId: string;
  actorId: string;
}): Promise<SettingsSnapshot> {
  const [providers, models, assignments, apiKeys, mcp] = await Promise.all([
    listProviderConnections({ ...input, includeDeploymentFallback: true }),
    listModelCatalog(input),
    listModelAssignments(input),
    listServiceApiKeys(input),
    getMcpExportConfiguration(input),
  ]);
  return {
    platform: {
      authEnforced: isAuthEnforced(),
      bootstrapConfigured: isBootstrapConfigured(),
      databaseConfigured: hasDatabaseUrl(),
      storageBackend: getStorageBackend(),
      releaseRevision:
        process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
        process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
        process.env.GITHUB_SHA?.trim() ||
        undefined,
    },
    vault: credentialVaultStatus(),
    providers,
    models,
    assignments,
    apiKeys,
    mcp,
    runtime: {
      tenantAssignmentsConsumed: true,
      activeScopes: ["main_agent", "orchestrator"],
      configurationOnlyScopes: ["workflow", "council", "memory", "embeddings", "vision", "audio"],
      message:
        "Main agent and Orchestrator use validated workspace routes. Workflow, Council, Memory, Embeddings, Vision, and Audio remain configuration-only and continue using deployment routing.",
    },
  };
}
