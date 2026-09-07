import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { showTruthfulIntegrationsService } from "@/lib/app-services/integrations";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listOAuthGrantsForRequest } from "@/lib/connectors/oauth-store";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import {
  projectSourceCoverage,
  type SourceCoverageDependency,
} from "@/lib/sources/coverage";
import { loadOwnedSourceCoverageInventory } from "@/lib/sources/coverage-store";

export const sourceCoverageServiceInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

type SourceCoverageDependencies = Readonly<{
  showIntegrations: typeof showTruthfulIntegrationsService;
  listOAuth: typeof listOAuthGrantsForRequest;
  loadOwnedSources: typeof loadOwnedSourceCoverageInventory;
  now: () => Date;
}>;

const defaultDependencies: SourceCoverageDependencies = Object.freeze({
  showIntegrations: showTruthfulIntegrationsService,
  listOAuth: listOAuthGrantsForRequest,
  loadOwnedSources: loadOwnedSourceCoverageInventory,
  now: () => new Date(),
});

export async function showSourceCoverageService(
  caller: AppServiceCaller,
  input: z.input<typeof sourceCoverageServiceInputSchema>,
  dependencies: SourceCoverageDependencies = defaultDependencies,
) {
  const value = sourceCoverageServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.sources.coverage.show"),
  );
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  const actorIds = actorBinding?.readableOwnerActorIds || [caller.context.actorId];

  return runWithDatabaseActorScope(
    caller.context.tenantId,
    actorIds,
    async () => {
      const [integrations, oauth, ownedSources] = await Promise.all([
        optionalSource("integrations", async () => (
          await dependencies.showIntegrations(caller, { workspaceId: value.workspaceId })
        ).data.overview),
        optionalSource("oauth", () => dependencies.listOAuth({
          tenantId: caller.context.tenantId,
          actorId: caller.context.actorId,
          requestActorBinding: actorBinding,
        })),
        optionalSource("owned_sources", () => dependencies.loadOwnedSources({
          tenantId: caller.context.tenantId,
          actorIds,
        })),
      ]);
      const coverage = projectSourceCoverage({
        integrations,
        oauth,
        ownedSources,
        generatedAt: dependencies.now().toISOString(),
      });
      return completeAppServiceCall(authorized, { coverage }, {
        resourceCount: coverage.domains.length,
        occurredAt: coverage.generatedAt,
      });
    },
  );
}

async function optionalSource<T>(
  source: "integrations" | "oauth" | "owned_sources",
  load: () => Promise<T>,
): Promise<SourceCoverageDependency<T>> {
  try {
    return { state: "ready", value: await load() };
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "sources.coverage_source_failed",
      source,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: safeErrorCode(error),
      timestamp: new Date().toISOString(),
    }));
    return {
      state: "unavailable",
      detail: `${sourceLabel(source)} is temporarily unavailable; no empty, disconnected, or complete state was inferred.`,
    };
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String(error.code);
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
}

function sourceLabel(source: "integrations" | "oauth" | "owned_sources") {
  return ({
    integrations: "Integration inventory",
    oauth: "OAuth source checkpoints",
    owned_sources: "Actor-owned source inventory",
  })[source];
}

export type { SourceCoverageDependencies };
