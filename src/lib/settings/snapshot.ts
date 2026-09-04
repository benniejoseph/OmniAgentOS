import { isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { getStorageBackend, hasDatabaseUrl } from "@/lib/db/client";
import { credentialVaultStatus } from "@/lib/settings/credential-vault";
import { listServiceApiKeysForRequest } from "@/lib/settings/service-api-keys";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import {
  getMcpExportConfiguration,
  listModelAssignments,
  listModelCatalogForRequest,
  listProviderConnections,
  listProviderConnectionsForRequest,
} from "@/lib/settings/store";
import type { SettingsSnapshot } from "@/lib/settings/types";

export async function getSettingsSnapshot(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  providerOwnerScope?: "readable";
}): Promise<SettingsSnapshot> {
  const exactOwner = { tenantId: input.tenantId, actorId: input.actorId };
  const requestReadOwner = {
    ...exactOwner,
    requestActorBinding: input.requestActorBinding,
  };
  const [providers, models, assignments, apiKeys, mcp] = await Promise.all([
    input.providerOwnerScope === "readable"
      ? listProviderConnectionsForRequest({
          ...exactOwner,
          requestActorBinding: requestReadOwner.requestActorBinding,
          includeDeploymentFallback: true,
        })
      : listProviderConnections({
          ...exactOwner,
          includeDeploymentFallback: true,
        }).then((records) => records.map((record) => ({
          ...record,
          manageable: record.source === "tenant_vault" &&
            record.actorId === input.actorId,
        }))),
    listModelCatalogForRequest(requestReadOwner),
    listModelAssignments(exactOwner),
    listServiceApiKeysForRequest(requestReadOwner),
    getMcpExportConfiguration(exactOwner),
  ]);
  return {
    requestReadContracts: {
      providerConnections: input.providerOwnerScope === "readable"
        ? "readable_v1"
        : "exact_v1",
    },
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
