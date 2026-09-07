import { z } from "zod";

import type { ConnectionCatalogItem } from "@/lib/connectors/catalog";
import {
  GOOGLE_CALENDAR_WRITE_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
} from "@/lib/connectors/oauth-providers";
import type { RequestOAuthGrant } from "@/lib/connectors/oauth-store";
import type {
  OpenApiConnectorRecord,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type {
  McpConnectorRecord,
  McpToolRecord,
} from "@/lib/connectors/types";
import type { SalesforceSyncHealth } from "@/lib/customer-success/salesforce-contracts";
import type { UsageSummary, UsageTotals } from "@/lib/usage/summary";

export const TRUTHFUL_INTEGRATIONS_VERSION =
  "p11.7-truthful-integrations:1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const countSchema = z.number().int().nonnegative();

const inventoryStateSchema = z.object({
  state: z.enum(["ready", "unavailable"]),
  detail: z.string().min(1).max(240),
}).strict();

const integrationFailureSchema = z.object({
  state: z.enum(["none", "present", "unknown"]),
  code: z.string().min(1).max(80).nullable(),
  message: z.string().min(1).max(500),
  recovery: z.string().min(1).max(500),
}).strict();

const integrationSyncSchema = z.object({
  supported: z.boolean(),
  status: z.enum([
    "not_applicable",
    "not_started",
    "syncing",
    "current",
    "stale",
    "partial",
    "error",
    "unavailable",
  ]),
  coverage: z.enum(["not_applicable", "none", "partial", "complete", "unknown"]),
  coverageDetail: z.string().min(1).max(500),
  cursor: z.object({
    state: z.enum([
      "not_applicable",
      "not_started",
      "advancing",
      "checkpointed",
      "unknown",
      "unavailable",
    ]),
    detail: z.string().min(1).max(500),
    rawValueIncluded: z.literal(false),
  }).strict(),
  lastSuccessfulAt: timestampSchema.nullable(),
  freshness: z.object({
    state: z.enum(["not_applicable", "never", "current", "stale", "unavailable"]),
    ageSeconds: countSchema.nullable(),
    staleAfterSeconds: countSchema.nullable(),
  }).strict(),
}).strict();

const integrationCostSchema = z.object({
  periodDays: z.literal(30),
  state: z.enum([
    "known",
    "partial",
    "unknown",
    "no_recorded_activity",
    "unavailable",
  ]),
  knownEstimatedCostMicrousd: countSchema.nullable(),
  knownCalls: countSchema,
  unknownCalls: countSchema,
  detail: z.string().min(1).max(500),
}).strict();

const installedIntegrationSchema = z.object({
  id: z.string().min(1).max(240),
  name: z.string().min(1).max(160),
  kind: z.enum(["google_service", "mcp", "openapi", "salesforce"]),
  adapter: z.enum(["native", "mcp", "openapi"]),
  category: z.enum(["code", "communication", "knowledge", "data", "automation", "browser"]),
  installation: z.enum(["installed", "retained_read_only"]),
  state: z.enum(["working", "degraded", "action_required", "unavailable"]),
  configured: z.boolean().nullable(),
  connected: z.boolean(),
  manageable: z.boolean(),
  permissions: z.object({
    mode: z.enum([
      "no_access",
      "read_only",
      "read_write",
      "write_approval_required",
      "unclassified",
    ]),
    granted: z.array(z.string().min(1).max(160)).max(32),
    missing: z.array(z.string().min(1).max(160)).max(32),
    activeOperations: countSchema,
    pendingReviewOperations: countSchema,
    disabledOperations: countSchema,
    approvalRequiredOperations: countSchema,
  }).strict(),
  sync: integrationSyncSchema,
  failure: integrationFailureSchema,
  cost: integrationCostSchema,
  nextAction: z.string().min(1).max(500),
  updatedAt: timestampSchema.nullable(),
  manageHref: z.string().startsWith("/app/").max(240),
}).strict();

const suggestionSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  adapter: z.enum(["native", "mcp", "openapi"]),
  category: z.enum(["code", "communication", "knowledge", "data", "automation", "browser"]),
  state: z.enum([
    "setup_available",
    "credentials_required",
    "configuration_required",
    "planned",
    "availability_unknown",
  ]),
  capabilities: z.array(z.string().min(1).max(100)).max(12),
  installed: z.literal(false),
  detail: z.string().min(1).max(500),
}).strict();

export const truthfulIntegrationsOverviewSchema = z.object({
  version: z.literal(TRUTHFUL_INTEGRATIONS_VERSION),
  generatedAt: timestampSchema,
  state: z.enum(["ready", "partial", "empty"]),
  disclosure: z.object({
    catalogSuggestions: z.literal("separate_from_installed"),
    credentialValuesIncluded: z.literal(false),
    rawCursorValuesIncluded: z.literal(false),
    providerContentIncluded: z.literal(false),
    costBasis: z.literal("recorded_attributable_usage_only"),
  }).strict(),
  summary: z.object({
    installed: countSchema,
    working: countSchema,
    degraded: countSchema,
    actionRequired: countSchema,
    unavailable: countSchema,
    suggestions: countSchema,
  }).strict(),
  inventory: z.object({
    oauth: inventoryStateSchema,
    mcp: inventoryStateSchema,
    openapi: inventoryStateSchema,
    salesforce: inventoryStateSchema,
    usage: inventoryStateSchema,
  }).strict(),
  installed: z.array(installedIntegrationSchema).max(200),
  suggestions: z.array(suggestionSchema).max(100),
}).strict();

export type TruthfulIntegrationsOverview = z.infer<
  typeof truthfulIntegrationsOverviewSchema
>;

export type IntegrationSource<T> = Readonly<
  | { state: "ready"; value: T }
  | { state: "unavailable"; detail: string }
>;

export type TruthfulIntegrationsInput = Readonly<{
  oauth: IntegrationSource<readonly RequestOAuthGrant[]>;
  mcp: IntegrationSource<Readonly<{
    connectors: readonly McpConnectorRecord[];
    tools: readonly McpToolRecord[];
  }>>;
  openapi: IntegrationSource<Readonly<{
    connectors: readonly OpenApiConnectorRecord[];
    operations: readonly OpenApiOperationRecord[];
  }>>;
  salesforce: IntegrationSource<Readonly<{
    health: SalesforceSyncHealth;
    writesConfigured: boolean;
  }>>;
  usage: IntegrationSource<UsageSummary>;
  oauthConfigured: Readonly<{ google: boolean; salesforce: boolean }>;
  catalog: readonly ConnectionCatalogItem[];
  generatedAt?: string;
}>;

const googleServices = Object.freeze([
  {
    id: "gmail",
    name: "Gmail",
    category: "communication" as const,
    requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    writeScope: GOOGLE_GMAIL_SEND_SCOPE,
    grantedRead: "Read mail and message metadata",
    grantedWrite: "Send reviewed email",
    missingRead: "Gmail read permission",
    sync: true,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "automation" as const,
    requiredScopes: [
      GOOGLE_CALENDAR_WRITE_SCOPE,
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
    writeScope: GOOGLE_CALENDAR_WRITE_SCOPE,
    grantedRead: "Read calendar events",
    grantedWrite: "Create and update reviewed events",
    missingRead: "Calendar event permission",
    sync: true,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "knowledge" as const,
    requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    writeScope: null,
    grantedRead: "Read files and export supported documents",
    grantedWrite: null,
    missingRead: "Drive read permission",
    sync: true,
  },
  {
    id: "google-photos",
    name: "Google Photos",
    category: "knowledge" as const,
    requiredScopes: [GOOGLE_PHOTOS_PICKER_SCOPE],
    writeScope: null,
    grantedRead: "Select and import user-picked media",
    grantedWrite: null,
    missingRead: "Google Photos picker permission",
    sync: false,
  },
]);

const GOOGLE_SYNC_STALE_SECONDS = 2 * 60 * 60;
const SALESFORCE_SYNC_STALE_SECONDS = 60 * 60;
const CONTRACT_STALE_SECONDS = 30 * 24 * 60 * 60;

export function projectTruthfulIntegrationsOverview(
  input: TruthfulIntegrationsInput,
): TruthfulIntegrationsOverview {
  const generatedAt = canonicalTimestamp(input.generatedAt || new Date().toISOString());
  const nowMs = Date.parse(generatedAt);
  const installed: TruthfulIntegrationsOverview["installed"] = [];
  const matchedCatalogIds = new Set<string>();

  if (input.oauth.state === "ready") {
    const googleGrant = input.oauth.value.find((grant) => grant.provider === "google");
    if (googleGrant) {
      for (const service of googleServices) {
        installed.push(projectGoogleService(
          service,
          googleGrant,
          input.oauthConfigured.google,
          nowMs,
        ));
        if (service.id !== "google-photos") matchedCatalogIds.add(service.id);
      }
    }
  }

  if (input.mcp.state === "ready") {
    for (const connector of input.mcp.value.connectors) {
      const catalogItem = matchCatalog(connector, "mcp", input.catalog);
      if (catalogItem) matchedCatalogIds.add(catalogItem.id);
      installed.push(projectMcpConnector(
        connector,
        input.mcp.value.tools.filter((tool) => tool.connectorId === connector.id),
        catalogItem,
        input.usage,
        nowMs,
      ));
    }
  }

  if (input.openapi.state === "ready") {
    for (const connector of input.openapi.value.connectors) {
      const catalogItem = matchCatalog(connector, "openapi", input.catalog);
      if (catalogItem) matchedCatalogIds.add(catalogItem.id);
      installed.push(projectOpenApiConnector(
        connector,
        input.openapi.value.operations.filter((operation) => operation.connectorId === connector.id),
        catalogItem,
        input.usage,
        nowMs,
      ));
    }
  }

  const salesforceGrant = input.oauth.state === "ready"
    ? input.oauth.value.find((grant) => grant.provider === "salesforce")
    : undefined;
  if (input.salesforce.state === "ready" &&
      (input.salesforce.value.health.connected || salesforceGrant)) {
    installed.push(projectSalesforce(
      input.salesforce.value.health,
      input.salesforce.value.writesConfigured,
      Boolean(salesforceGrant?.manageable),
      input.usage,
      nowMs,
    ));
  }

  installed.sort((left, right) =>
    integrationStateRank(left.state) - integrationStateRank(right.state) ||
    left.name.localeCompare(right.name));

  const suggestions = projectSuggestions(input, matchedCatalogIds, Boolean(salesforceGrant));
  const sourceUnavailable = [input.oauth, input.mcp, input.openapi, input.salesforce, input.usage]
    .some((source) => source.state === "unavailable");
  const overview = {
    version: TRUTHFUL_INTEGRATIONS_VERSION,
    generatedAt,
    state: sourceUnavailable ? "partial" as const : installed.length ? "ready" as const : "empty" as const,
    disclosure: {
      catalogSuggestions: "separate_from_installed" as const,
      credentialValuesIncluded: false as const,
      rawCursorValuesIncluded: false as const,
      providerContentIncluded: false as const,
      costBasis: "recorded_attributable_usage_only" as const,
    },
    summary: {
      installed: installed.length,
      working: installed.filter((item) => item.state === "working").length,
      degraded: installed.filter((item) => item.state === "degraded").length,
      actionRequired: installed.filter((item) => item.state === "action_required").length,
      unavailable: installed.filter((item) => item.state === "unavailable").length,
      suggestions: suggestions.length,
    },
    inventory: {
      oauth: inventory(input.oauth, "OAuth connection inventory is current."),
      mcp: inventory(input.mcp, "MCP connection inventory is current."),
      openapi: inventory(input.openapi, "OpenAPI connection inventory is current."),
      salesforce: inventory(input.salesforce, "Salesforce workspace health is current."),
      usage: inventory(input.usage, "Attributable 30-day usage receipts are current."),
    },
    installed,
    suggestions,
  };
  return truthfulIntegrationsOverviewSchema.parse(overview);
}

function projectGoogleService(
  service: (typeof googleServices)[number],
  grant: RequestOAuthGrant,
  configured: boolean,
  nowMs: number,
): TruthfulIntegrationsOverview["installed"][number] {
  const hasRead = service.requiredScopes.some((scope) => grant.scopes.includes(scope));
  const hasWrite = Boolean(service.writeScope && grant.scopes.includes(service.writeScope));
  const expired = Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= nowMs);
  const manageable = grant.manageable === true;
  const freshness = service.sync
    ? freshnessFrom(grant.lastSyncedAt, GOOGLE_SYNC_STALE_SECONDS, nowMs)
    : notApplicableFreshness();
  const syncStatus = !service.sync
    ? "not_applicable" as const
    : grant.syncStatus === "syncing"
      ? "syncing" as const
      : grant.syncStatus === "error"
        ? "error" as const
        : !grant.lastSyncedAt
          ? "not_started" as const
          : freshness.state === "unavailable"
            ? "unavailable" as const
          : freshness.state === "stale"
            ? "stale" as const
            : "current" as const;
  const cursorState = !service.sync
    ? notApplicableCursor("This user-selected import does not use a background cursor.")
    : !manageable
      ? unavailableCursor("The retained connection's cursor remains visible only to its stored owner.")
      : grant.syncStatus === "syncing"
        ? cursor("advancing", "The owner-scoped checkpoint is advancing; raw provider cursor values stay private.")
        : grant.lastSyncedAt
          ? cursor("checkpointed", "A successful owner-scoped checkpoint exists; raw provider cursor values stay private.")
          : grant.syncStatus === "error"
            ? cursor("unknown", "No successful checkpoint is visible after the reported sync failure.")
            : cursor("not_started", "No successful checkpoint has been recorded.");
  const failure = grant.syncStatus === "error"
    ? presentFailure(
        "google_sync_error",
        safeText(grant.syncError, "Google synchronization reported an error."),
        manageable ? "Retry sync; reconnect Google if the error persists." : "Reconnect from the stored owner account.",
      )
    : noFailure();
  const state = !configured || expired || !hasRead || grant.syncStatus === "error" || syncStatus === "unavailable"
    ? "action_required" as const
    : syncStatus === "stale" || syncStatus === "syncing" || !manageable
      ? "degraded" as const
      : "working" as const;
  const nextAction = !configured
    ? "Configure the Google OAuth application before relying on this connection."
    : expired
      ? "Reconnect Google because the current grant has expired."
      : !hasRead
        ? `Reconnect Google and grant ${service.missingRead.toLowerCase()}.`
        : !manageable
          ? "Use the stored owner account to manage or resynchronize this retained connection."
          : grant.syncStatus === "error"
            ? "Retry sync, then reconnect if the failure remains."
            : syncStatus === "unavailable"
              ? "Review the invalid sync timestamp before trusting freshness."
            : syncStatus === "stale" || syncStatus === "not_started"
              ? "Run Google sync now."
              : service.sync
                ? "No action required; monitor the next scheduled sync."
                : "No action required; imports happen only after an explicit picker selection.";
  return {
    id: `google:${service.id}`,
    name: service.name,
    kind: "google_service",
    adapter: "native",
    category: service.category,
    installation: manageable ? "installed" : "retained_read_only",
    state,
    configured,
    connected: grant.status === "active" && !expired,
    manageable,
    permissions: {
      mode: !hasRead ? "no_access" : hasWrite ? "write_approval_required" : "read_only",
      granted: [
        ...(hasRead ? [service.grantedRead] : []),
        ...(hasWrite && service.grantedWrite ? [service.grantedWrite] : []),
      ],
      missing: [
        ...(!hasRead ? [service.missingRead] : []),
        ...(service.writeScope && !hasWrite ? [`Optional ${service.name} write permission`] : []),
      ],
      activeOperations: Number(hasRead) + Number(hasWrite),
      pendingReviewOperations: 0,
      disabledOperations: 0,
      approvalRequiredOperations: hasWrite ? 1 : 0,
    },
    sync: {
      supported: service.sync,
      status: syncStatus,
      coverage: !service.sync ? "not_applicable" : !hasRead ? "none" : syncStatus === "error" ? "partial" : grant.lastSyncedAt ? "complete" : "none",
      coverageDetail: !service.sync
        ? "Media is imported only from an explicit user picker; no background source is implied."
        : !hasRead
          ? `${service.name} is outside the granted OAuth scope.`
          : `The grant records ${grant.syncedItems || 0} items across Google; per-source totals are not retained, so no ${service.name}-only count is inferred.`,
      cursor: cursorState,
      lastSuccessfulAt: service.sync ? grant.lastSyncedAt || null : null,
      freshness,
    },
    failure,
    cost: unknownCost("Google provider charges are not attributable in Asael; downstream AI processing appears only in the unified consumption ledger."),
    nextAction,
    updatedAt: grant.updatedAt,
    manageHref: "/app/connectors",
  };
}

function projectMcpConnector(
  connectorRecord: McpConnectorRecord,
  tools: readonly McpToolRecord[],
  catalogItem: ConnectionCatalogItem | undefined,
  usage: IntegrationSource<UsageSummary>,
  nowMs: number,
): TruthfulIntegrationsOverview["installed"][number] {
  const active = tools.filter((tool) => tool.status === "active");
  const pending = tools.filter((tool) => tool.status === "pending_review");
  const disabled = tools.filter((tool) => tool.status === "disabled");
  const readOnly = active.filter((tool) => annotationBoolean(tool.annotations, "readOnlyHint") === true);
  const declaredWrite = active.filter((tool) => annotationBoolean(tool.annotations, "readOnlyHint") === false);
  const unclassified = active.length - readOnly.length - declaredWrite.length;
  const credentialReady = connectorRecord.authType === "none" ||
    connectorRecord.authType === "bearer_env" && Boolean(connectorRecord.authTokenEnv) ||
    connectorRecord.authType === "bearer_vault" && connectorRecord.credentialConfigured === true && connectorRecord.credentialOriginMatch === true;
  const freshness = freshnessFrom(connectorRecord.lastDiscoveredAt, CONTRACT_STALE_SECONDS, nowMs);
  const failure = connectorRecord.status === "error"
    ? presentFailure(
        "mcp_connection_error",
        "The MCP connection reported an error; provider text is withheld from this aggregate view.",
        "Check the endpoint and credential, then rediscover its exact tool contracts.",
      )
    : noFailure();
  const state = connectorRecord.status !== "active" || !credentialReady || !active.length || pending.length ||
      freshness.state === "never" || freshness.state === "unavailable"
    ? "action_required" as const
    : freshness.state === "stale" || unclassified
      ? "degraded" as const
      : "working" as const;
  const mode = !active.length
    ? "no_access" as const
    : unclassified
      ? "unclassified" as const
      : declaredWrite.length
        ? declaredWrite.some((tool) => tool.approvalRequired)
          ? "write_approval_required" as const
          : "read_write" as const
        : "read_only" as const;
  const nextAction = connectorRecord.status === "disabled"
    ? "Enable only after credentials and reviewed tool contracts are current."
    : connectorRecord.status === "error"
      ? "Repair the endpoint or credential and rediscover tools."
      : !credentialReady
        ? "Store or rotate the credential bound to this exact endpoint."
        : pending.length
          ? `Review ${pending.length} changed tool contract${pending.length === 1 ? "" : "s"}.`
          : !active.length
            ? "Discover and review at least one governed tool."
            : freshness.state === "never" || freshness.state === "unavailable"
              ? "Rediscover tools because a valid discovery timestamp is unavailable."
            : freshness.state === "stale"
              ? "Rediscover tools to refresh the catalog."
              : unclassified
                ? "Review tools whose server annotations do not declare read versus write behavior."
                : "No action required; the reviewed tool catalog is usable.";
  return {
    id: `mcp:${connectorRecord.id}`,
    name: safeText(catalogItem?.name || connectorRecord.name, "MCP connection"),
    kind: "mcp",
    adapter: "mcp",
    category: catalogItem?.category || "automation",
    installation: "installed",
    state,
    configured: credentialReady,
    connected: connectorRecord.status === "active" && credentialReady && active.length > 0,
    manageable: true,
    permissions: {
      mode,
      granted: active.slice(0, 12).map((tool) => safeText(tool.title || tool.name, "Governed tool")),
      missing: [
        ...(pending.length ? [`${pending.length} contract${pending.length === 1 ? "" : "s"} awaiting review`] : []),
        ...(unclassified ? [`${unclassified} active operation${unclassified === 1 ? "" : "s"} without read/write annotation`] : []),
      ],
      activeOperations: active.length,
      pendingReviewOperations: pending.length,
      disabledOperations: disabled.length,
      approvalRequiredOperations: active.filter((tool) => tool.approvalRequired).length,
    },
    sync: contractSync(connectorRecord.lastDiscoveredAt, freshness, "tool discovery"),
    failure,
    cost: connectorCost(connectorRecord.endpoint, usage),
    nextAction,
    updatedAt: connectorRecord.updatedAt,
    manageHref: "/app/connectors",
  };
}

function projectOpenApiConnector(
  connectorRecord: OpenApiConnectorRecord,
  operations: readonly OpenApiOperationRecord[],
  catalogItem: ConnectionCatalogItem | undefined,
  usage: IntegrationSource<UsageSummary>,
  nowMs: number,
): TruthfulIntegrationsOverview["installed"][number] {
  const active = operations.filter((operation) => operation.status === "active");
  const pending = operations.filter((operation) => operation.status === "pending_review");
  const disabled = operations.filter((operation) => operation.status === "disabled");
  const writes = active.filter((operation) => !["GET", "HEAD", "OPTIONS"].includes(operation.method));
  const credentialReady = connectorRecord.authType === "none" || Boolean(connectorRecord.authTokenEnv);
  const freshness = freshnessFrom(connectorRecord.lastImportedAt, CONTRACT_STALE_SECONDS, nowMs);
  const failure = connectorRecord.status === "error"
    ? presentFailure(
        "openapi_connection_error",
        "The OpenAPI connection reported an error; provider text is withheld from this aggregate view.",
        "Check the specification, base URL, and credential binding, then import the exact contracts again.",
      )
    : noFailure();
  const state = connectorRecord.status !== "active" || !credentialReady || !active.length || pending.length ||
      freshness.state === "never" || freshness.state === "unavailable"
    ? "action_required" as const
    : freshness.state === "stale"
      ? "degraded" as const
      : "working" as const;
  const nextAction = connectorRecord.status === "disabled"
    ? "Enable only after credentials and reviewed operation contracts are current."
    : connectorRecord.status === "error"
      ? "Repair the specification, base URL, or credential and re-import operations."
      : !credentialReady
        ? "Configure the exact deployment credential binding."
        : pending.length
          ? `Review ${pending.length} changed operation contract${pending.length === 1 ? "" : "s"}.`
          : !active.length
            ? "Import and review at least one governed operation."
            : freshness.state === "never" || freshness.state === "unavailable"
              ? "Re-import the specification because a valid import timestamp is unavailable."
            : freshness.state === "stale"
              ? "Re-import the specification to refresh the contract catalog."
              : "No action required; the reviewed operation catalog is usable.";
  return {
    id: `openapi:${connectorRecord.id}`,
    name: safeText(catalogItem?.name || connectorRecord.name, "OpenAPI connection"),
    kind: "openapi",
    adapter: "openapi",
    category: catalogItem?.category || "automation",
    installation: "installed",
    state,
    configured: credentialReady,
    connected: connectorRecord.status === "active" && credentialReady && active.length > 0,
    manageable: true,
    permissions: {
      mode: !active.length ? "no_access" : writes.length
        ? writes.some((operation) => operation.approvalRequired)
          ? "write_approval_required"
          : "read_write"
        : "read_only",
      granted: active.slice(0, 12).map((operation) =>
        `${operation.method} ${safeText(operation.summary || operation.operationId, "operation")}`),
      missing: pending.length
        ? [`${pending.length} contract${pending.length === 1 ? "" : "s"} awaiting review`]
        : [],
      activeOperations: active.length,
      pendingReviewOperations: pending.length,
      disabledOperations: disabled.length,
      approvalRequiredOperations: active.filter((operation) => operation.approvalRequired).length,
    },
    sync: contractSync(connectorRecord.lastImportedAt, freshness, "OpenAPI import"),
    failure,
    cost: connectorCost(connectorRecord.baseUrl, usage),
    nextAction,
    updatedAt: connectorRecord.updatedAt,
    manageHref: "/app/connectors",
  };
}

function projectSalesforce(
  health: SalesforceSyncHealth,
  writesConfigured: boolean,
  manageable: boolean,
  usage: IntegrationSource<UsageSummary>,
  nowMs: number,
): TruthfulIntegrationsOverview["installed"][number] {
  const cursorObjects = health.cursor ? Object.values(health.cursor.objects) : [];
  const currentObjects = cursorObjects.filter((item) => item.phase === "current").length;
  const advancingObjects = cursorObjects.filter((item) => item.phase === "backfill" || item.phase === "delta").length;
  const pendingObjects = cursorObjects.filter((item) => item.phase === "pending").length;
  const freshness = freshnessFrom(health.lastSuccessfulSyncAt || undefined, SALESFORCE_SYNC_STALE_SECONDS, nowMs);
  const status = !health.connected
    ? "not_started" as const
    : health.status === "backfilling" || health.status === "syncing"
      ? "syncing" as const
      : health.status === "healthy"
        ? freshness.state === "unavailable"
          ? "unavailable" as const
          : freshness.state === "stale" ? "stale" as const : "current" as const
        : health.status === "degraded"
          ? "partial" as const
          : health.status === "error"
            ? "error" as const
            : "not_started" as const;
  const failure = health.actionableError
    ? presentFailure(
        health.actionableError.code,
        safeText(health.actionableError.message, "Salesforce synchronization reported an error."),
        salesforceRecovery(health.actionableError.action),
      )
    : noFailure();
  const state = !health.configured || !health.connected || health.status === "error" || status === "unavailable"
    ? "action_required" as const
    : status === "stale" || status === "syncing" || status === "partial"
      ? "degraded" as const
      : "working" as const;
  return {
    id: "salesforce:workspace",
    name: "Salesforce",
    kind: "salesforce",
    adapter: "native",
    category: "data",
    installation: manageable ? "installed" : "retained_read_only",
    state,
    configured: health.configured,
    connected: health.connected,
    manageable,
    permissions: {
      mode: writesConfigured ? "write_approval_required" : "read_only",
      granted: [
        `${health.objectScope.length} read-only CRM objects`,
        ...(writesConfigured ? ["Guarded Account 360 writes require approval and account activation"] : []),
      ],
      missing: writesConfigured ? [] : ["Production Salesforce write gate and reviewed external ID field"],
      activeOperations: health.objectScope.length,
      pendingReviewOperations: 0,
      disabledOperations: writesConfigured ? 0 : 11,
      approvalRequiredOperations: writesConfigured ? 11 : 0,
    },
    sync: {
      supported: true,
      status,
      coverage: !health.connected || !cursorObjects.length
        ? "none"
        : currentObjects === health.objectScope.length
          ? "complete"
          : currentObjects || advancingObjects ? "partial" : "none",
      coverageDetail: health.connected
        ? `${currentObjects}/${health.objectScope.length} object cursors current · ${advancingObjects} advancing · ${pendingObjects} pending.`
        : "No workspace-bound Salesforce connection exists, so object coverage is zero.",
      cursor: !health.connected
        ? cursor("not_started", "No workspace-bound Salesforce cursor exists.")
        : advancingObjects
          ? cursor("advancing", `${advancingObjects} object cursor${advancingObjects === 1 ? " is" : "s are"} advancing; provider paths and record IDs are withheld.`)
          : cursorObjects.length
            ? cursor("checkpointed", `${currentObjects}/${health.objectScope.length} object cursors are checkpointed; provider paths and record IDs are withheld.`)
            : cursor("unknown", "Salesforce is connected but no valid object cursor was returned."),
      lastSuccessfulAt: health.lastSuccessfulSyncAt,
      freshness,
    },
    failure,
    cost: usage.state === "unavailable"
      ? unavailableCost()
      : unknownCost("Salesforce API and license charges are not reported to Asael; no provider bill is inferred from sync activity."),
    nextAction: !health.configured
      ? "Configure the Salesforce Connected App before connecting a workspace."
      : !health.connected
        ? "Connect Salesforce to the canonical workspace."
        : health.actionableError
          ? salesforceRecovery(health.actionableError.action)
          : status === "unavailable"
            ? "Review the invalid Salesforce freshness timestamp before trusting this connection."
          : status === "stale" || status === "not_started"
            ? "Run Salesforce sync now."
            : status === "syncing" || status === "partial"
              ? "Let the resumable backfill continue, then review any remaining object cursors."
              : "No action required; monitor cursor freshness and reconciliation findings.",
    updatedAt: health.evaluatedAt,
    manageHref: "/app/accounts",
  };
}

function projectSuggestions(
  input: TruthfulIntegrationsInput,
  matchedCatalogIds: ReadonlySet<string>,
  hasSalesforceGrant: boolean,
) {
  const suggestions: TruthfulIntegrationsOverview["suggestions"] = [];
  const googleCatalogIds = new Set(["gmail", "google-drive", "google-calendar"]);
  if (input.oauth.state === "unavailable") {
    suggestions.push({
      id: "google-workspace",
      name: "Google Workspace",
      adapter: "native",
      category: "knowledge",
      state: "availability_unknown",
      capabilities: ["Gmail", "Calendar", "Drive", "Photos picker"],
      installed: false,
      detail: "OAuth inventory is unavailable, so Asael cannot safely decide whether this source is installed.",
    });
  } else if (!input.oauth.value.some((grant) => grant.provider === "google")) {
    suggestions.push({
      id: "google-workspace",
      name: "Google Workspace",
      adapter: "native",
      category: "knowledge",
      state: input.oauthConfigured.google ? "setup_available" : "configuration_required",
      capabilities: ["Gmail", "Calendar", "Drive", "Photos picker"],
      installed: false,
      detail: input.oauthConfigured.google
        ? "OAuth is configured, but no active owner grant is installed."
        : "Deployment OAuth credentials are required before an owner can connect.",
    });
  }

  for (const item of input.catalog) {
    if (googleCatalogIds.has(item.id) || matchedCatalogIds.has(item.id)) continue;
    const inventorySource = item.adapter === "mcp" ? input.mcp : item.adapter === "openapi" ? input.openapi : undefined;
    const availabilityUnknown = inventorySource?.state === "unavailable";
    suggestions.push({
      id: safeText(item.id, "integration"),
      name: safeText(item.name, "Integration"),
      adapter: item.adapter,
      category: item.category,
      state: availabilityUnknown
        ? "availability_unknown"
        : item.status === "planned"
          ? "planned"
          : item.status === "requires_credentials"
            ? "credentials_required"
            : "setup_available",
      capabilities: item.capabilities.slice(0, 12).map((capability) => safeText(capability, "Capability")),
      installed: false,
      detail: availabilityUnknown
        ? `${item.adapter.toUpperCase()} inventory is unavailable, so installed status cannot be resolved safely.`
        : item.status === "planned"
          ? "This adapter is planned and cannot be connected yet."
          : item.status === "requires_credentials"
            ? "This is a catalog option, not an installed connection; credentials are still required."
            : "This is a catalog option, not an installed or working connection.",
    });
  }

  if (!hasSalesforceGrant && input.salesforce.state === "ready" && !input.salesforce.value.health.connected) {
    suggestions.push({
      id: "salesforce",
      name: "Salesforce",
      adapter: "native",
      category: "data",
      state: input.oauthConfigured.salesforce ? "setup_available" : "configuration_required",
      capabilities: ["CRM backfill", "delta sync", "webhooks", "read-only reconciliation", "guarded writes"],
      installed: false,
      detail: input.oauthConfigured.salesforce
        ? "The native adapter is available, but no active workspace connection is installed."
        : "A Salesforce Connected App is required before a workspace can connect.",
    });
  } else if (!hasSalesforceGrant && input.salesforce.state === "unavailable") {
    suggestions.push({
      id: "salesforce",
      name: "Salesforce",
      adapter: "native",
      category: "data",
      state: "availability_unknown",
      capabilities: ["CRM backfill", "delta sync", "webhooks", "read-only reconciliation", "guarded writes"],
      installed: false,
      detail: "Salesforce workspace health is unavailable, so installed status cannot be resolved safely.",
    });
  }
  return suggestions.sort((left, right) => left.name.localeCompare(right.name)).slice(0, 100);
}

function contractSync(
  observedAt: string | undefined,
  freshness: ReturnType<typeof freshnessFrom>,
  label: string,
): TruthfulIntegrationsOverview["installed"][number]["sync"] {
  return {
    supported: false,
    status: "not_applicable",
    coverage: "not_applicable",
    coverageDetail: `This connector executes governed operations and does not mirror a data source; ${label} freshness is shown instead.`,
    cursor: notApplicableCursor("No synchronization cursor applies to this connector."),
    lastSuccessfulAt: observedAt || null,
    freshness,
  };
}

function connectorCost(location: string, usage: IntegrationSource<UsageSummary>) {
  if (usage.state === "unavailable") return unavailableCost();
  if (!/api\.browser-use\.com/i.test(location)) {
    return unknownCost("This provider does not report attributable charges into Asael; configured subscriptions and external billing are not inferred.");
  }
  const provider = usage.value.periods.month.providers.find((item) => item.id === "browser_use");
  if (!provider) {
    return {
      periodDays: 30 as const,
      state: "no_recorded_activity" as const,
      knownEstimatedCostMicrousd: 0,
      knownCalls: 0,
      unknownCalls: 0,
      detail: "No Browser Use calls were recorded in Asael during the last 30 days; this does not assert a zero subscription bill.",
    };
  }
  return usageCost(provider.totals);
}

function usageCost(totals: UsageTotals) {
  const knownEstimatedCostMicrousd = Math.round(totals.knownEstimatedCostUsd * 1_000_000);
  const state = totals.knownCostCalls && totals.unknownCostCalls
    ? "partial" as const
    : totals.knownCostCalls
      ? "known" as const
      : totals.unknownCostCalls
        ? "unknown" as const
        : "no_recorded_activity" as const;
  return {
    periodDays: 30 as const,
    state,
    knownEstimatedCostMicrousd,
    knownCalls: totals.knownCostCalls,
    unknownCalls: totals.unknownCostCalls,
    detail: state === "known"
      ? "All recorded Browser Use calls in the last 30 days have an estimated provider cost."
      : state === "partial"
        ? "Only part of the recorded Browser Use activity has an estimated provider cost."
        : state === "unknown"
          ? "Browser Use activity was recorded, but its provider cost is unavailable."
          : "No attributable Browser Use activity was recorded; external subscription charges are not inferred.",
  };
}

function unknownCost(detail: string) {
  return {
    periodDays: 30 as const,
    state: "unknown" as const,
    knownEstimatedCostMicrousd: null,
    knownCalls: 0,
    unknownCalls: 0,
    detail,
  };
}

function unavailableCost() {
  return {
    periodDays: 30 as const,
    state: "unavailable" as const,
    knownEstimatedCostMicrousd: null,
    knownCalls: 0,
    unknownCalls: 0,
    detail: "The usage ledger is unavailable, so no cost state is inferred.",
  };
}

function freshnessFrom(value: string | undefined, staleAfterSeconds: number, nowMs: number) {
  if (!value) return {
    state: "never" as const,
    ageSeconds: null,
    staleAfterSeconds,
  };
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > nowMs) return {
    state: "unavailable" as const,
    ageSeconds: null,
    staleAfterSeconds,
  };
  const ageSeconds = Math.max(0, Math.floor((nowMs - at) / 1_000));
  return {
    state: ageSeconds > staleAfterSeconds ? "stale" as const : "current" as const,
    ageSeconds,
    staleAfterSeconds,
  };
}

function notApplicableFreshness() {
  return {
    state: "not_applicable" as const,
    ageSeconds: null,
    staleAfterSeconds: null,
  };
}

function cursor(state: "not_started" | "advancing" | "checkpointed" | "unknown", detail: string) {
  return { state, detail, rawValueIncluded: false as const };
}

function notApplicableCursor(detail: string) {
  return { state: "not_applicable" as const, detail, rawValueIncluded: false as const };
}

function unavailableCursor(detail: string) {
  return { state: "unavailable" as const, detail, rawValueIncluded: false as const };
}

function noFailure() {
  return {
    state: "none" as const,
    code: null,
    message: "No current failure is reported.",
    recovery: "No failure recovery is required.",
  };
}

function presentFailure(code: string, message: string, recovery: string) {
  return {
    state: "present" as const,
    code: safeCode(code),
    message: safeText(message, "The integration reported a failure."),
    recovery: safeText(recovery, "Review the connection and retry safely."),
  };
}

function inventory<T>(source: IntegrationSource<T>, readyDetail: string) {
  return source.state === "ready"
    ? { state: "ready" as const, detail: readyDetail }
    : { state: "unavailable" as const, detail: safeText(source.detail, "Inventory is unavailable.") };
}

function matchCatalog(
  connectorRecord: McpConnectorRecord | OpenApiConnectorRecord,
  adapter: "mcp" | "openapi",
  catalog: readonly ConnectionCatalogItem[],
) {
  const name = searchable(connectorRecord.name);
  const location = adapter === "mcp"
    ? (connectorRecord as McpConnectorRecord).endpoint
    : (connectorRecord as OpenApiConnectorRecord).baseUrl;
  return catalog.find((item) => {
    if (item.adapter !== adapter) return false;
    const itemLocation = adapter === "mcp" ? item.endpoint : item.baseUrl;
    return item.id === connectorRecord.id ||
      Boolean(itemLocation && sameLocation(location, itemLocation)) ||
      searchable(item.name) === name;
  });
}

function sameLocation(left: string, right: string) {
  try {
    const first = new URL(left);
    const second = new URL(right);
    return first.protocol === second.protocol && first.hostname === second.hostname &&
      first.pathname.replace(/\/+$/, "") === second.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function annotationBoolean(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function salesforceRecovery(action: SalesforceSyncHealth["actionableError"] extends infer T
  ? T extends { action: infer A } ? A : never : never) {
  const actions: Record<string, string> = {
    reconnect: "Reconnect Salesforce from the workspace owner account.",
    review_permissions: "Review the Salesforce Connected App and granted API scopes.",
    retry: "Retry the resumable Salesforce sync.",
    restart_backfill: "Restart the Salesforce backfill from its safe object checkpoints.",
    review_conflict: "Review the reported Salesforce reconciliation conflict.",
    contact_support: "Inspect the server-side failure receipt and contact support if it persists.",
  };
  return actions[String(action)] || "Review the Salesforce connection and retry safely.";
}

function integrationStateRank(state: TruthfulIntegrationsOverview["installed"][number]["state"]) {
  return ({ action_required: 0, unavailable: 1, degraded: 2, working: 3 })[state];
}

function safeCode(value: string) {
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : "integration_failure";
}

function safeText(value: unknown, fallback: string) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return text || fallback;
}

function searchable(value: string) {
  return safeText(value, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Integration overview requires a valid generatedAt timestamp.");
  return parsed.toISOString();
}
