import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { connectionCatalog } from "@/lib/connectors/catalog";
import {
  projectTruthfulIntegrationsOverview,
  type IntegrationSource,
  type TruthfulIntegrationsInput,
} from "@/lib/connectors/truthful-overview";
import { oauthConfigured } from "@/lib/connectors/oauth-providers";
import { listOAuthGrantsForRequest } from "@/lib/connectors/oauth-store";
import {
  listOpenApiConnectors,
  listOpenApiOperations,
} from "@/lib/connectors/openapi-store";
import { listMcpConnectors, listMcpTools } from "@/lib/connectors/store";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";
import { getSalesforceSyncHealth } from "@/lib/customer-success/salesforce-store";
import { getSalesforceWriteConfiguration } from "@/lib/customer-success/salesforce-write-contracts";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { loadUsageSummary } from "@/lib/usage/summary";

export const truthfulIntegrationsServiceInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

type TruthfulIntegrationsDependencies = Readonly<{
  listOAuth: typeof listOAuthGrantsForRequest;
  loadMcp: (tenantId: string) => Promise<{
    connectors: Awaited<ReturnType<typeof listMcpConnectors>>;
    tools: Awaited<ReturnType<typeof listMcpTools>>;
  }>;
  loadOpenApi: (tenantId: string) => Promise<{
    connectors: Awaited<ReturnType<typeof listOpenApiConnectors>>;
    operations: Awaited<ReturnType<typeof listOpenApiOperations>>;
  }>;
  loadSalesforce: (
    caller: AppServiceCaller,
    workspaceId: string | undefined,
  ) => Promise<{
    health: Awaited<ReturnType<typeof getSalesforceSyncHealth>>;
    writesConfigured: boolean;
  }>;
  loadUsage: typeof loadUsageSummary;
  oauthConfigured: (provider: "google" | "salesforce") => boolean;
  catalog: TruthfulIntegrationsInput["catalog"];
  now: () => Date;
}>;

const defaultDependencies: TruthfulIntegrationsDependencies = Object.freeze({
  listOAuth: listOAuthGrantsForRequest,
  loadMcp: async (tenantId) => ({
    connectors: await listMcpConnectors(100, { tenantId }),
    tools: await listMcpTools(undefined, { tenantId }),
  }),
  loadOpenApi: async (tenantId) => ({
    connectors: await listOpenApiConnectors(100, { tenantId }),
    operations: await listOpenApiOperations(undefined, { tenantId }),
  }),
  loadSalesforce: async (caller, workspaceId) => {
    const access = await resolveSalesforceRequestAccess(caller.context, {
      workspaceId,
      mode: "read",
      correlationId: crypto.randomUUID(),
    });
    return {
      health: await getSalesforceSyncHealth(
        access.readAuthority,
        oauthConfigured("salesforce"),
      ),
      writesConfigured: getSalesforceWriteConfiguration().configured,
    };
  },
  loadUsage: loadUsageSummary,
  oauthConfigured,
  catalog: connectionCatalog,
  now: () => new Date(),
});

export async function showTruthfulIntegrationsService(
  caller: AppServiceCaller,
  input: z.input<typeof truthfulIntegrationsServiceInputSchema>,
  dependencies: TruthfulIntegrationsDependencies = defaultDependencies,
) {
  const value = truthfulIntegrationsServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.integrations.overview.show"),
  );
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  return runWithDatabaseActorScope(
    caller.context.tenantId,
    actorBinding?.readableOwnerActorIds || [caller.context.actorId],
    async () => {
      const [oauth, mcp, openapi, salesforce, usage] = await Promise.all([
        optionalSource("oauth", () => dependencies.listOAuth({
          tenantId: caller.context.tenantId,
          actorId: caller.context.actorId,
          requestActorBinding: actorBinding,
        })),
        optionalSource("mcp", () => dependencies.loadMcp(caller.context.tenantId)),
        optionalSource("openapi", () => dependencies.loadOpenApi(caller.context.tenantId)),
        optionalSource("salesforce", () => dependencies.loadSalesforce(caller, value.workspaceId)),
        optionalSource("usage", () => dependencies.loadUsage({
          tenantId: caller.context.tenantId,
          now: dependencies.now(),
        })),
      ]);
      const overview = projectTruthfulIntegrationsOverview({
        oauth,
        mcp,
        openapi,
        salesforce,
        usage,
        oauthConfigured: {
          google: dependencies.oauthConfigured("google"),
          salesforce: dependencies.oauthConfigured("salesforce"),
        },
        catalog: dependencies.catalog,
        generatedAt: dependencies.now().toISOString(),
      });
      return completeAppServiceCall(authorized, { overview }, {
        resourceCount: overview.installed.length,
        occurredAt: overview.generatedAt,
      });
    },
  );
}

async function optionalSource<T>(
  source: "oauth" | "mcp" | "openapi" | "salesforce" | "usage",
  load: () => Promise<T>,
): Promise<IntegrationSource<T>> {
  try {
    return { state: "ready", value: await load() };
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "integrations.overview_source_failed",
      source,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: safeErrorCode(error),
      timestamp: new Date().toISOString(),
    }));
    return {
      state: "unavailable",
      detail: `${sourceLabel(source)} inventory is temporarily unavailable; no disconnected or healthy state was inferred.`,
    };
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String(error.code);
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
}

function sourceLabel(source: "oauth" | "mcp" | "openapi" | "salesforce" | "usage") {
  return ({
    oauth: "OAuth",
    mcp: "MCP",
    openapi: "OpenAPI",
    salesforce: "Salesforce",
    usage: "Usage",
  })[source];
}

export type { TruthfulIntegrationsDependencies };
