import { describe, expect, it } from "vitest";

import { connectionCatalog } from "@/lib/connectors/catalog";
import {
  projectTruthfulIntegrationsOverview,
  TRUTHFUL_INTEGRATIONS_VERSION,
} from "@/lib/connectors/truthful-overview";
import {
  initialSalesforceSyncCursor,
  SALESFORCE_OBJECT_TYPES,
  type SalesforceSyncHealth,
} from "@/lib/customer-success/salesforce-contracts";
import type { UsageSummary, UsageTotals } from "@/lib/usage/summary";

const now = "2026-09-07T12:00:00.000Z";

describe("truthful integrations overview", () => {
  it("separates installed access from catalog suggestions and reports exact permission and sync states", () => {
    const overview = projectTruthfulIntegrationsOverview({
      oauth: { state: "ready", value: [{
        id: "grant-google",
        tenantId: "tenant:test",
        actorId: "owner@example.test",
        provider: "google",
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
        ],
        status: "active",
        authorizationGeneration: 2,
        syncStatus: "healthy",
        lastSyncedAt: "2026-09-07T11:45:00.000Z",
        syncedItems: 42,
        sourceCoverage: {},
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-07T11:45:00.000Z",
        manageable: true,
      }] },
      mcp: { state: "ready", value: {
        connectors: [{
          id: "browser",
          tenantId: "tenant:test",
          name: "Playwright Browser",
          endpoint: "https://asael.bennierichard.com/api/integrations/playwright/mcp",
          transport: "streamable_http",
          authType: "bearer_vault",
          credentialConfigured: true,
          credentialOriginMatch: true,
          status: "active",
          defaultRiskLevel: 1,
          approvalRequired: false,
          toolCount: 2,
          lastDiscoveredAt: "2026-09-07T10:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-07T10:00:00.000Z",
        }],
        tools: [{
          id: "tool:read",
          tenantId: "tenant:test",
          connectorId: "browser",
          connectorName: "Playwright Browser",
          name: "browser_snapshot",
          inputSchema: {},
          annotations: { readOnlyHint: true },
          riskLevel: 0,
          approvalRequired: false,
          status: "active",
          createdAt: now,
          updatedAt: now,
        }, {
          id: "tool:write",
          tenantId: "tenant:test",
          connectorId: "browser",
          connectorName: "Playwright Browser",
          name: "browser_click",
          inputSchema: {},
          annotations: { readOnlyHint: false },
          riskLevel: 1,
          approvalRequired: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        }],
      } },
      openapi: { state: "ready", value: { connectors: [], operations: [] } },
      salesforce: { state: "ready", value: {
        health: salesforceHealth(true),
        writesConfigured: false,
      } },
      usage: { state: "ready", value: usageSummary() },
      oauthConfigured: { google: true, salesforce: false },
      catalog: connectionCatalog,
      generatedAt: now,
    });

    expect(overview.version).toBe(TRUTHFUL_INTEGRATIONS_VERSION);
    expect(overview.installed).toHaveLength(6);
    expect(overview.installed.find((item) => item.name === "Gmail")).toMatchObject({
      connected: true,
      state: "working",
      permissions: { mode: "write_approval_required" },
      sync: {
        status: "current",
        coverage: "complete",
        cursor: { state: "checkpointed", rawValueIncluded: false },
      },
    });
    expect(overview.installed.find((item) => item.name === "Playwright Browser")).toMatchObject({
      state: "working",
      permissions: {
        mode: "write_approval_required",
        activeOperations: 2,
        approvalRequiredOperations: 1,
      },
      sync: { status: "not_applicable" },
      cost: { state: "unknown" },
    });
    expect(overview.installed.find((item) => item.name === "Salesforce")).toMatchObject({
      connected: true,
      permissions: { mode: "read_only", disabledOperations: 11 },
      sync: {
        status: "current",
        coverage: "complete",
        cursor: { state: "checkpointed", rawValueIncluded: false },
      },
    });
    expect(overview.suggestions.every((item) => item.installed === false)).toBe(true);
    expect(overview.suggestions.find((item) => item.id === "slack")).toMatchObject({
      state: "credentials_required",
      installed: false,
    });
    expect(overview.installed.every((item) => item.sync.cursor.rawValueIncluded === false)).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("grant-google");
  });

  it("does not turn stale, failed, or unattributable telemetry into healthy or zero-cost claims", () => {
    const overview = projectTruthfulIntegrationsOverview({
      oauth: { state: "ready", value: [{
        id: "grant-google",
        tenantId: "tenant:test",
        actorId: "owner@example.test",
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        status: "active",
        authorizationGeneration: 1,
        syncStatus: "error",
        syncError: "rate limit",
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        syncedItems: 10,
        sourceCoverage: {},
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-07T11:00:00.000Z",
        manageable: false,
      }] },
      mcp: { state: "ready", value: { connectors: [], tools: [] } },
      openapi: { state: "ready", value: { connectors: [], operations: [] } },
      salesforce: { state: "ready", value: { health: salesforceHealth(false), writesConfigured: false } },
      usage: { state: "ready", value: usageSummary() },
      oauthConfigured: { google: true, salesforce: false },
      catalog: connectionCatalog,
      generatedAt: now,
    });

    const gmail = overview.installed.find((item) => item.name === "Gmail");
    const drive = overview.installed.find((item) => item.name === "Google Drive");
    expect(gmail).toMatchObject({
      installation: "retained_read_only",
      state: "action_required",
      sync: { status: "error", cursor: { state: "unavailable" } },
      failure: { state: "present", code: "google_sync_error" },
      cost: { state: "unknown", knownEstimatedCostMicrousd: null },
    });
    expect(drive).toMatchObject({
      state: "action_required",
      permissions: { mode: "no_access", granted: [] },
    });
  });

  it("marks failed inventories unavailable instead of presenting them as disconnected", () => {
    const unavailable = { state: "unavailable" as const, detail: "source unavailable" };
    const overview = projectTruthfulIntegrationsOverview({
      oauth: unavailable,
      mcp: unavailable,
      openapi: unavailable,
      salesforce: unavailable,
      usage: unavailable,
      oauthConfigured: { google: true, salesforce: true },
      catalog: connectionCatalog,
      generatedAt: now,
    });

    expect(overview.state).toBe("partial");
    expect(overview.installed).toEqual([]);
    expect(overview.inventory.oauth.state).toBe("unavailable");
    expect(overview.suggestions.find((item) => item.id === "google-workspace")?.state).toBe("availability_unknown");
    expect(overview.suggestions.find((item) => item.id === "salesforce")?.state).toBe("availability_unknown");
  });
});

function salesforceHealth(connected: boolean): SalesforceSyncHealth {
  const cursor = initialSalesforceSyncCursor();
  for (const item of Object.values(cursor.objects)) {
    item.phase = "current";
    item.watermarkAt = connected ? "2026-09-07T11:59:00.000Z" : null;
  }
  return {
    schemaVersion: 1 as const,
    contractVersion: "p10.10-salesforce-read-sync:1" as const,
    configured: connected,
    connected,
    connectionId: connected ? `salesforce-connection:${"a".repeat(64)}` : null,
    workspaceId: "workspace:test",
    status: connected ? "healthy" as const : "configuration_required" as const,
    accessMode: "read_only" as const,
    objectScope: [...SALESFORCE_OBJECT_TYPES],
    purposeScope: ["customer_success.account.read", "customer_success.crm_sync"],
    cursor: connected ? cursor : null,
    lagSeconds: connected ? 60 : null,
    lastSuccessfulSyncAt: connected ? "2026-09-07T11:59:00.000Z" : null,
    lastWebhookAt: null,
    lastReplayIdSha256: null,
    actionableError: null,
    evaluatedAt: now,
  };
}

function usageSummary(): UsageSummary {
  const totals = emptyTotals();
  const period = (key: "day" | "week" | "month") => ({
    key,
    label: key,
    currentLabel: key,
    previousLabel: key,
    currentStartAt: now,
    currentEndAt: now,
    previousStartAt: now,
    previousEndAt: now,
    bucketUnit: "day" as const,
    current: totals,
    previous: totals,
    series: [],
    providers: [],
    models: [],
  });
  return {
    generatedAt: now,
    scopeLabel: "test",
    disclosure: "test",
    sourceEventLimitReached: false,
    periods: { day: period("day"), week: period("week"), month: period("month") },
  };
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    runs: 0,
    modelCalls: 0,
    sourceStreams: 0,
    providerCalls: 0,
    attempts: 0,
    failedAttempts: 0,
    failedCalls: 0,
    knownEstimatedCostUsd: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    costCoveragePercent: 0,
  };
}
