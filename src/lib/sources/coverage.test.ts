import { describe, expect, it } from "vitest";

import type { RequestOAuthGrant } from "@/lib/connectors/oauth-store";
import type { TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";
import {
  projectSourceCoverage,
  SOURCE_COVERAGE_VERSION,
  type OwnedSourceCoverageInventory,
} from "@/lib/sources/coverage";

const now = "2026-09-08T12:00:00.000Z";

describe("P11.9 source coverage projection", () => {
  it("reports granular backfill, freshness, index completeness, and explicit blind spots", () => {
    const projection = projectSourceCoverage({
      integrations: { state: "ready", value: overview([
        googleIntegration("google:gmail", "Gmail"),
        googleIntegration("google:google-calendar", "Google Calendar"),
        googleIntegration("google:google-drive", "Google Drive"),
      ]) },
      oauth: { state: "ready", value: [googleGrant({
        mail: checkpoint("complete", "2026-09-08T11:30:00.000Z"),
        calendar: checkpoint("in_progress", "2026-09-08T11:40:00.000Z"),
        drive: checkpoint("complete", "2026-09-08T08:00:00.000Z"),
      })] },
      ownedSources: { state: "ready", value: ownedInventory() },
      generatedAt: now,
    });

    expect(projection.version).toBe(SOURCE_COVERAGE_VERSION);
    expect(projection.disclosure).toEqual({
      absenceInference: "forbidden",
      rawCursorValuesIncluded: false,
      providerContentIncluded: false,
      actorCoordinatesIncluded: false,
    });
    expect(domain(projection, "gmail")).toMatchObject({
      availability: "connected",
      coverage: { state: "complete", observedItems: 12 },
      backfill: { state: "complete" },
      freshness: { state: "current", lastVerifiedAt: "2026-09-08T11:30:00.000Z" },
      blindSpot: false,
    });
    expect(domain(projection, "google_calendar")).toMatchObject({
      coverage: { state: "partial" },
      backfill: { state: "in_progress" },
      blindSpot: true,
    });
    expect(domain(projection, "google_drive").freshness.state).toBe("stale");
    expect(domain(projection, "contacts")).toMatchObject({
      availability: "unsupported",
      coverage: { state: "unknown" },
      blindSpot: true,
    });
    expect(projection.knowledgeIndex).toMatchObject({
      state: "complete",
      sourceItems: 18,
      indexedDocuments: 18,
      chunks: 42,
      embeddedChunks: 42,
    });
    expect(projection.summary.staleDomains).toBeGreaterThanOrEqual(1);
    expect(projection.summary.blindSpots).toBeGreaterThanOrEqual(14);
    expect(JSON.stringify(projection)).not.toMatch(/cursor-value|actor:test|provider content/i);
  });

  it("keeps a connected source unknown until a source-specific checkpoint exists", () => {
    const projection = projectSourceCoverage({
      integrations: { state: "ready", value: overview([
        googleIntegration("google:gmail", "Gmail"),
      ]) },
      oauth: { state: "ready", value: [googleGrant({})] },
      ownedSources: { state: "ready", value: ownedInventory() },
      generatedAt: now,
    });

    expect(domain(projection, "gmail")).toMatchObject({
      availability: "connected",
      coverage: { state: "unknown", observedItems: 12 },
      backfill: { state: "unknown" },
      freshness: { state: "unknown" },
      blindSpot: true,
    });
  });

  it("does not turn unavailable inventories or absent connections into negative facts", () => {
    const projection = projectSourceCoverage({
      integrations: { state: "unavailable", detail: "provider inventory unavailable" },
      oauth: { state: "unavailable", detail: "checkpoint inventory unavailable" },
      ownedSources: { state: "unavailable", detail: "index inventory unavailable" },
      generatedAt: now,
    });

    expect(projection.state).toBe("partial");
    expect(domain(projection, "gmail")).toMatchObject({
      availability: "unavailable",
      coverage: { state: "unknown", observedItems: null },
      freshness: { state: "unknown" },
    });
    expect(projection.knowledgeIndex.state).toBe("unknown");
    expect(projection.knowledgeIndex.sourceItems).toBeNull();
  });
});

function domain(projection: ReturnType<typeof projectSourceCoverage>, id: string) {
  const result = projection.domains.find((item) => item.id === id);
  if (!result) throw new Error(`Missing coverage domain ${id}.`);
  return result;
}

function checkpoint(
  backfillState: "complete" | "in_progress" | "unknown",
  lastSuccessfulAt: string,
) {
  return {
    schemaVersion: 1 as const,
    status: "healthy" as const,
    backfillState,
    lastAttemptedAt: lastSuccessfulAt,
    lastSuccessfulAt,
    failureCode: "none" as const,
  };
}

function googleGrant(sourceCoverage: RequestOAuthGrant["sourceCoverage"]): RequestOAuthGrant {
  return {
    id: "grant:test",
    tenantId: "tenant:test",
    actorId: "actor:test",
    provider: "google",
    scopes: [],
    status: "active",
    authorizationGeneration: 1,
    syncStatus: "healthy",
    syncedItems: 18,
    sourceCoverage,
    manageable: true,
    createdAt: now,
    updatedAt: now,
  };
}

function ownedInventory(): OwnedSourceCoverageInventory {
  return {
    domains: [
      { id: "gmail", currentItems: 12, lastObservedAt: "2026-09-08T11:30:00.000Z" },
      { id: "google_calendar", currentItems: 4, lastObservedAt: "2026-09-08T11:40:00.000Z" },
      { id: "google_drive", currentItems: 2, lastObservedAt: "2026-09-08T08:00:00.000Z" },
    ],
    knowledgeIndex: {
      sourceItems: 18,
      indexedDocuments: 18,
      chunks: 42,
      embeddedChunks: 42,
      lastIndexedAt: "2026-09-08T11:45:00.000Z",
    },
    capture: { total: 0, indexed: 0, pending: 0, failed: 0, lastUpdatedAt: null },
  };
}

function overview(installed: TruthfulIntegrationsOverview["installed"]): TruthfulIntegrationsOverview {
  return {
    version: "p11.7-truthful-integrations:1",
    generatedAt: now,
    state: "ready",
    disclosure: {
      catalogSuggestions: "separate_from_installed",
      credentialValuesIncluded: false,
      rawCursorValuesIncluded: false,
      providerContentIncluded: false,
      costBasis: "recorded_attributable_usage_only",
    },
    summary: {
      installed: installed.length,
      working: installed.length,
      degraded: 0,
      actionRequired: 0,
      unavailable: 0,
      suggestions: 0,
    },
    inventory: Object.fromEntries(
      ["oauth", "mcp", "openapi", "salesforce", "usage"].map((key) => [
        key,
        { state: "ready", detail: `${key} ready` },
      ]),
    ) as TruthfulIntegrationsOverview["inventory"],
    installed,
    suggestions: [],
  };
}

function googleIntegration(
  id: string,
  name: string,
): TruthfulIntegrationsOverview["installed"][number] {
  return {
    id,
    name,
    kind: "google_service",
    adapter: "native",
    category: "knowledge",
    installation: "installed",
    state: "working",
    configured: true,
    connected: true,
    manageable: true,
    permissions: {
      mode: "read_only",
      granted: ["Read"],
      missing: [],
      activeOperations: 1,
      pendingReviewOperations: 0,
      disabledOperations: 0,
      approvalRequiredOperations: 0,
    },
    sync: {
      supported: true,
      status: "current",
      coverage: "complete",
      coverageDetail: "Provider-level summary only.",
      cursor: { state: "checkpointed", detail: "Checkpoint exists.", rawValueIncluded: false },
      lastSuccessfulAt: "2026-09-08T11:30:00.000Z",
      freshness: { state: "current", ageSeconds: 1_800, staleAfterSeconds: 7_200 },
    },
    failure: { state: "none", code: null, message: "No failure.", recovery: "No recovery required." },
    cost: { periodDays: 30, state: "no_recorded_activity", knownEstimatedCostMicrousd: 0, knownCalls: 0, unknownCalls: 0, detail: "No usage." },
    nextAction: "No action required.",
    updatedAt: now,
    manageHref: "/app/connectors",
  };
}
