import { describe, expect, it } from "vitest";

import {
  buildGraphQueryTelemetry,
  GRAPH_STORAGE_DECISION_THRESHOLDS,
  parseGraphQueryTelemetry,
  summarizeGraphQueryTelemetry,
  type GraphQueryTelemetry,
} from "@/lib/entities/graph-query-telemetry";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import type { GraphStorageShadowComparison } from "@/lib/entities/graph-storage-adapter";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const recordedAt = "2026-09-07T00:00:00.000Z";
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
  correlationId: "graph-telemetry-test",
  purpose: "entity.read.v1",
});

function shadow(
  state: GraphStorageShadowComparison["state"] = "not_configured",
): GraphStorageShadowComparison {
  const configured = state !== "not_configured";
  const body = {
    version: "p5.6-graph-storage-shadow:1" as const,
    primaryAdapterId: "postgres-temporal-graph:1",
    shadowAdapterId: configured ? "candidate-graph:1" : null,
    state,
    primarySnapshotSha256: "a".repeat(64),
    shadowSnapshotSha256: configured && state !== "failed"
      ? (state === "matched" ? "a" : "b").repeat(64)
      : null,
    primaryDurationMs: 25,
    shadowDurationMs: configured ? 18 : null,
  };
  return {
    ...body,
    comparisonSha256: sourceContractSha256(body),
  };
}

function sample(input: {
  durationMs?: number;
  entityCount?: number;
  saturated?: boolean;
  shadowState?: GraphStorageShadowComparison["state"];
} = {}): GraphQueryTelemetry {
  return buildGraphQueryTelemetry({
    accessBinding: binding,
    executionScope: scope,
    shadow: shadow(input.shadowState),
    maxHops: 2,
    requestedLimit: 12,
    entityCount: input.entityCount || 20,
    aliasCount: 4,
    relationCandidateCount: input.saturated ? 200 : 8,
    relationLimitSaturated: input.saturated || false,
    authorizedRelationCount: input.saturated ? 180 : 7,
    rejectedRelationCount: input.saturated ? 20 : 1,
    pathCount: 3,
    evidenceAuthorizationDurationMs: 15,
    pathExpansionDurationMs: 4,
    totalDurationMs: input.durationMs || 50,
    recordedAt,
  });
}

function report(samples: readonly GraphQueryTelemetry[]) {
  return summarizeGraphQueryTelemetry(samples, {
    windowHours: 168,
    generatedAt: "2026-09-07T01:00:00.000Z",
    primaryAdapterId: "postgres-temporal-graph:1",
  });
}

describe("P5.6 graph query telemetry", () => {
  it("records a digest-verified content-free measurement", () => {
    const telemetry = sample({ durationMs: 73, saturated: true });

    expect(parseGraphQueryTelemetry(telemetry)).toEqual(telemetry);
    expect(telemetry).toMatchObject({
      version: "p5.6-graph-query-telemetry:1",
      tenantId: binding.tenantId,
      ownerActorId: binding.ownerActorId,
      queryKind: "relationship_paths",
      status: "succeeded",
      primaryAdapterId: "postgres-temporal-graph:1",
      shadowState: "not_configured",
      relationLimitSaturated: true,
      totalDurationMs: 73,
    });
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("Acme Labs");
    expect(serialized).not.toMatch(
      /queryText|querySha|canonicalLabel|excerpt|evidenceId|pathId/i,
    );

    const tampered = { ...telemetry, pathCount: telemetry.pathCount + 1 };
    expect(() => parseGraphQueryTelemetry(tampered)).toThrow(/digest/i);
  });

  it("requires the exact actor-private read scope", () => {
    const siblingScope = createExecutionScope({
      tenantId: binding.tenantId,
      initiatingActorId: "actor-b",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-b",
      correlationId: "graph-telemetry-test",
      purpose: "entity.read.v1",
    });
    expect(() => buildGraphQueryTelemetry({
      accessBinding: binding,
      executionScope: siblingScope,
      shadow: shadow(),
      maxHops: 2,
      requestedLimit: 12,
      entityCount: 0,
      aliasCount: 0,
      relationCandidateCount: 0,
      relationLimitSaturated: false,
      authorizedRelationCount: 0,
      rejectedRelationCount: 0,
      pathCount: 0,
      evidenceAuthorizationDurationMs: 0,
      pathExpansionDurationMs: 0,
      totalDurationMs: 1,
      recordedAt,
    })).toThrow(/exact user scope/i);
  });

  it("retains Postgres until enough measured pressure exists", () => {
    const insufficient = report(Array.from({ length: 99 }, () =>
      sample({ durationMs: 1_000, saturated: true })
    ));
    expect(insufficient).toMatchObject({
      sampleCount: 99,
      disposition: "collect_more_telemetry",
      scaleJustifiesShadowEvaluation: false,
      shadowPromotionReady: false,
    });

    const healthy = report(Array.from({ length: 100 }, () => sample()));
    expect(healthy).toMatchObject({
      sampleCount: 100,
      p95DurationMs: 50,
      disposition: "retain_postgres",
      scaleJustifiesShadowEvaluation: false,
      shadowPromotionReady: false,
    });
  });

  it("requires measured pressure and 100% shadow parity before promotion review", () => {
    const pressured = report(Array.from({ length: 100 }, () =>
      sample({ durationMs: 900 })
    ));
    expect(pressured).toMatchObject({
      p95DurationMs: 900,
      disposition: "evaluate_shadow_adapter",
      scaleJustifiesShadowEvaluation: true,
      shadowPromotionReady: false,
    });

    const parityGate = report(Array.from({
      length: GRAPH_STORAGE_DECISION_THRESHOLDS.minimumShadowSamples,
    }, () => sample({ durationMs: 900, shadowState: "matched" })));
    expect(parityGate).toMatchObject({
      shadowSampleCount:
        GRAPH_STORAGE_DECISION_THRESHOLDS.minimumShadowSamples,
      shadowParityBasisPoints: 10_000,
      disposition: "eligible_for_reviewed_promotion",
      scaleJustifiesShadowEvaluation: true,
      shadowPromotionReady: true,
    });

    const mismatch = report([
      ...Array.from({ length: 999 }, () =>
        sample({ durationMs: 900, shadowState: "matched" })
      ),
      sample({ durationMs: 900, shadowState: "mismatched" }),
    ]);
    expect(mismatch).toMatchObject({
      shadowMismatchCount: 1,
      shadowPromotionReady: false,
      disposition: "evaluate_shadow_adapter",
    });

    const otherShadow = sample({
      durationMs: 900,
      shadowState: "matched",
    });
    const otherShadowBody = {
      ...otherShadow,
      shadowAdapterId: "other-candidate:1",
    };
    const mixedCandidates = report([
      ...Array.from({ length: 999 }, () =>
        sample({ durationMs: 900, shadowState: "matched" })
      ),
      {
        ...otherShadowBody,
        telemetrySha256: sourceContractSha256((({
          telemetrySha256: _digest,
          ...body
        }) => body)(otherShadowBody)),
      },
    ]);
    expect(mixedCandidates).toMatchObject({
      observedShadowAdapterCount: 2,
      shadowSampleCount: 999,
      shadowPromotionReady: false,
      disposition: "evaluate_shadow_adapter",
    });
  });
});
