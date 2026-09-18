import "server-only";

import { modelSupportsAssignmentRole } from "@/lib/settings/model-assignment-contract";
import {
  getProviderCredentials,
  listModelAssignments,
  listModelCatalog,
  listProviderConnections,
} from "@/lib/settings/store";
import type { ModelAssignment } from "@/lib/settings/types";
import type { SemanticDecisionProvider } from "@/lib/semantic-decisions/types";
import { createTypeSafeSemanticDecisionProvider } from "@/lib/semantic-decisions/typesafe-provider";

export type SemanticDecisionRuntimeUnavailableReason =
  | "catalog_model_unavailable"
  | "connection_unavailable"
  | "credential_unavailable";

type SemanticDecisionAssignmentReceipt = Readonly<{
  assignmentScope: "semantic_decision";
  assignmentId: string;
  assignmentRevision: number;
  assignmentConfigurationSha256: string;
  credentialSource: "tenant_vault";
}>;

export type SemanticDecisionRuntime = Readonly<{
  state: "ready" | "unavailable";
  providerId: "typesafe";
  model: string;
  assignment: ModelAssignment;
  assignmentReceipt: SemanticDecisionAssignmentReceipt;
  provider?: SemanticDecisionProvider;
  unavailableReason?: SemanticDecisionRuntimeUnavailableReason;
}>;

type SemanticDecisionRuntimeDependencies = Readonly<{
  listAssignments: typeof listModelAssignments;
  listCatalog: typeof listModelCatalog;
  listConnections: typeof listProviderConnections;
  openCredentials: typeof getProviderCredentials;
  createProvider: typeof createTypeSafeSemanticDecisionProvider;
}>;

const defaultDependencies: SemanticDecisionRuntimeDependencies = {
  listAssignments: listModelAssignments,
  listCatalog: listModelCatalog,
  listConnections: listProviderConnections,
  openCredentials: getProviderCredentials,
  createProvider: createTypeSafeSemanticDecisionProvider,
};

/**
 * Resolves only an explicit actor-owned Settings assignment. There is no
 * deployment-environment credential or model fallback for semantic decisions.
 */
export async function resolveSemanticDecisionRuntime(
  input: { tenantId: string; actorId: string },
  dependencies: SemanticDecisionRuntimeDependencies = defaultDependencies,
): Promise<SemanticDecisionRuntime | undefined> {
  if (semanticDecisionShadowGloballyDisabled()) return undefined;
  const tenantId = input.tenantId.trim();
  const actorId = input.actorId.trim();
  if (!tenantId || !actorId) return undefined;

  let assignments: Awaited<ReturnType<typeof listModelAssignments>>;
  let catalog: Awaited<ReturnType<typeof listModelCatalog>>;
  let connections: Awaited<ReturnType<typeof listProviderConnections>>;
  try {
    [assignments, catalog, connections] = await Promise.all([
      dependencies.listAssignments({ tenantId, actorId }),
      dependencies.listCatalog({ tenantId, actorId }),
      dependencies.listConnections({
        tenantId,
        actorId,
        includeDeploymentFallback: false,
      }),
    ]);
  } catch {
    // A read failure cannot safely establish actor opt-in, so fail closed.
    return undefined;
  }

  const assignment = assignments.find((candidate) =>
    candidate.scope === "semantic_decision"
  );
  if (
    !assignment ||
    assignment.provider !== "typesafe" ||
    assignment.runtimeReadiness !== "active" ||
    assignment.contractVersion !== "p11.8-model-assignment:1" ||
    !assignment.configurationSha256 ||
    !assignment.validatedAt ||
    assignment.fallbackProvider ||
    assignment.fallbackModelId ||
    assignment.allowCrossProviderFallback
  ) {
    return undefined;
  }
  const assignmentReceipt = Object.freeze({
    assignmentScope: "semantic_decision" as const,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    assignmentConfigurationSha256: assignment.configurationSha256,
    credentialSource: "tenant_vault" as const,
  });
  const unavailable = (
    reason: SemanticDecisionRuntimeUnavailableReason,
  ): SemanticDecisionRuntime => Object.freeze({
    state: "unavailable",
    providerId: "typesafe",
    model: assignment.modelId,
    assignment,
    assignmentReceipt,
    unavailableReason: reason,
  });
  const model = catalog.find((candidate) =>
    candidate.provider === "typesafe" &&
    candidate.modelId === assignment.modelId
  );
  if (
    !model ||
    !modelSupportsAssignmentRole(
      "semantic_decision",
      "typesafe",
      model,
    )
  ) {
    return unavailable("catalog_model_unavailable");
  }
  const connection = connections.find((candidate) =>
    candidate.provider === "typesafe" &&
    candidate.source === "tenant_vault" &&
    candidate.status === "connected" &&
    candidate.enabled
  );
  if (!connection) return unavailable("connection_unavailable");

  try {
    const opened = await dependencies.openCredentials({
      tenantId,
      actorId,
      connectionId: connection.id,
    });
    const apiKey = opened.connection.provider === "typesafe"
      ? opened.credentials.apiKey?.trim()
      : undefined;
    if (!apiKey) return unavailable("credential_unavailable");
    return Object.freeze({
      state: "ready",
      providerId: "typesafe",
      model: assignment.modelId,
      assignment,
      assignmentReceipt,
      provider: dependencies.createProvider({ apiKey }),
    });
  } catch {
    return unavailable("credential_unavailable");
  }
}

export function semanticDecisionShadowGloballyDisabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return environment.OMNIAGENT_SEMANTIC_DECISION_SHADOW_DISABLED
    ?.trim()
    .toLowerCase() === "true";
}
