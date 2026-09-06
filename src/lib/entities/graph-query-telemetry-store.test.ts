import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGraphQueryTelemetry,
  getGraphStorageDecisionReport,
  recordGraphQueryTelemetry,
} from "@/lib/entities/graph-query-telemetry";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "asael-graph-telemetry-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  vi.stubEnv("DATABASE_URL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

describe("P5.6 graph query telemetry store", () => {
  it("persists one actor-owned sample and one metadata-only typed event", async () => {
    const binding = buildEntityAccessBinding({
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      visibility: "user_private",
      sensitivity: "confidential",
      allowedPurposeIds: ENTITY_PURPOSE_IDS,
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    });
    const scope = createExecutionScope({
      tenantId: binding.tenantId,
      initiatingActorId: binding.ownerActorId,
      executingPrincipalType: "user",
      executingPrincipalId: binding.ownerActorId,
      correlationId: "graph-store-test",
      purpose: "entity.read.v1",
    });
    const shadowBody = {
      version: "p5.6-graph-storage-shadow:1" as const,
      primaryAdapterId: "postgres-temporal-graph:1",
      shadowAdapterId: null,
      state: "not_configured" as const,
      primarySnapshotSha256: "a".repeat(64),
      shadowSnapshotSha256: null,
      primaryDurationMs: 10,
      shadowDurationMs: null,
    };
    const telemetry = buildGraphQueryTelemetry({
      accessBinding: binding,
      executionScope: scope,
      shadow: {
        ...shadowBody,
        comparisonSha256: sourceContractSha256(shadowBody),
      },
      maxHops: 2,
      requestedLimit: 12,
      entityCount: 4,
      aliasCount: 1,
      relationCandidateCount: 2,
      relationLimitSaturated: false,
      authorizedRelationCount: 2,
      rejectedRelationCount: 0,
      pathCount: 1,
      evidenceAuthorizationDurationMs: 5,
      pathExpansionDurationMs: 2,
      totalDurationMs: 20,
      recordedAt: "2026-09-07T00:00:00.000Z",
    });

    await recordGraphQueryTelemetry({ telemetry, executionScope: scope });
    await recordGraphQueryTelemetry({ telemetry, executionScope: scope });
    const report = await getGraphStorageDecisionReport({
      accessBinding: binding,
      executionScope: scope,
      windowHours: 720,
    });

    expect(report).toMatchObject({
      sampleCount: 1,
      successfulSampleCount: 1,
      primaryAdapterId: "postgres-temporal-graph:1",
      disposition: "collect_more_telemetry",
    });
    const ledger = JSON.parse(await readFile(
      path.join(dataDirectory, "graph-query-telemetry.json"),
      "utf8",
    )) as { samples: unknown[] };
    const events = JSON.parse(await readFile(
      path.join(dataDirectory, "events.json"),
      "utf8",
    )) as { events: Array<{ type: string; payload: unknown }> };
    expect(ledger.samples).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "graph.query.measured"))
      .toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /queryText|canonicalLabel|excerpt|evidenceId|pathId/i,
    );
  });
});
