import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MissionSummaryOnly,
  disableMissionSummaryCapabilities,
  missionBaseSelection,
  missionCollectionIsReadable,
  missionCommandActionBlocked,
  missionCreateActionBlocked,
  missionDetailRequestIsCurrent,
  missionEventFailureClosesRow,
  missionFailureClearsCollection,
  missionDetailHasExpectedId,
  missionNeedsDeepExactReproof,
  missionRequestIsCurrent,
  missionRouteAfterReproof,
  missionRouteSelection,
  missionSelectionMode,
  missionTaskActionBlocked,
  normalizeMissionDetail,
  normalizeMissionSummaries,
} from "@/components/missions/mission-workspace";
import type { MissionSummaryView } from "@/lib/missions/public";

const exactMission: MissionSummaryView = {
  id: "mission-exact",
  title: "Launch the durable release",
  objective: "Ship the release with verified evidence.",
  status: "draft",
  canonicalStatus: {
    schemaVersion: 1,
    status: "preview",
    domain: "mission",
    basis: "legacy_status",
    source: "legacy_adapter",
    sourceStatus: "draft",
    verificationState: "unassessed",
  },
  priority: "high",
  source: "user",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T01:00:00.000Z",
  detailAvailable: true,
  manageable: true,
  runnable: true,
};

const retainedMission: MissionSummaryView = {
  ...exactMission,
  id: "mission-retained",
  title: "Retained planning history",
  detailAvailable: false,
  manageable: false,
  runnable: false,
};

describe("Mission request-readable UI", () => {
  it("selects exact, retained, and unverified surfaces independently", () => {
    expect(missionSelectionMode(exactMission, "readable_v1")).toBe("exact");
    expect(missionSelectionMode(retainedMission, "readable_v1")).toBe("retained");
    expect(missionSelectionMode(exactMission, "exact_v1")).toBe("unverified");
    expect(missionSelectionMode(exactMission, "readable_v1", true)).toBe("unverified");
  });

  it("requires freshness, permission, and the matching row capability", () => {
    expect(missionCreateActionBlocked({
      contract: "readable_v1",
      loading: false,
    })).toBeUndefined();
    expect(missionCreateActionBlocked({
      contract: "exact_v1",
      loading: false,
    })).toContain("could not be verified");
    expect(missionTaskActionBlocked({
      mission: retainedMission,
      contract: "readable_v1",
      loading: false,
    })).toContain("read only");
    expect(missionTaskActionBlocked({
      mission: exactMission,
      contract: "readable_v1",
      loading: false,
      permissionBlocked: "Operator access required.",
    })).toBe("Operator access required.");
    expect(missionCommandActionBlocked({
      mission: { ...exactMission, runnable: false },
      contract: "readable_v1",
      loading: false,
    })).toContain("cannot enter Command");
  });

  it("clears every actionable row flag while collection access is stale", () => {
    const [disabled] = disableMissionSummaryCapabilities([exactMission]);
    expect(disabled).toMatchObject({
      detailAvailable: false,
      manageable: false,
      runnable: false,
    });
    expect(missionSelectionMode(disabled, undefined)).toBe("unverified");
  });

  it("accepts only strict acknowledged summary collections", () => {
    expect(missionCollectionIsReadable("readable_v1")).toBe(true);
    expect(missionCollectionIsReadable("exact_v1")).toBe(false);
    const normalized = normalizeMissionSummaries([{
      ...exactMission,
      canonicalStatus: {
        ...exactMission.canonicalStatus,
        tenantId: "nested-tenant-secret",
      },
      tenantId: "tenant-secret",
      actorId: "actor-secret",
      sourceKey: "private-source-key",
    }, retainedMission]);
    expect(normalized).toEqual([
      exactMission,
      retainedMission,
    ]);
    expect(normalized?.[0]).not.toHaveProperty("tenantId");
    expect(normalized?.[0]).not.toHaveProperty("actorId");
    expect(normalized?.[0]).not.toHaveProperty("sourceKey");
    expect(normalized?.[0].canonicalStatus).not.toHaveProperty("tenantId");
    expect(normalizeMissionSummaries([{ ...exactMission, manageable: undefined }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{ ...retainedMission, runnable: true }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([exactMission, exactMission]))
      .toBeUndefined();
    expect(normalizeMissionSummaries(Array.from({ length: 51 }, (_, index) => ({
      ...exactMission,
      id: `mission-${index}`,
    })))).toBeUndefined();
    expect(normalizeMissionSummaries([{ ...exactMission, id: "x".repeat(241) }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{ ...exactMission, title: " x" }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{ ...exactMission, objective: "x".repeat(4_001) }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{ ...exactMission, source: "x".repeat(81) }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{ ...exactMission, updatedAt: "2026-09-05" }]))
      .toBeUndefined();
    expect(normalizeMissionSummaries([{
      ...exactMission,
      canonicalStatus: { ...exactMission.canonicalStatus, status: "running" },
    }])).toBeUndefined();
  });

  it("suppresses aborted and superseded collection results", () => {
    const current = new AbortController();
    const stale = new AbortController();
    expect(missionRequestIsCurrent({
      currentController: current,
      requestController: current,
      currentGeneration: 4,
      requestGeneration: 4,
    })).toBe(true);
    expect(missionRequestIsCurrent({
      currentController: current,
      requestController: stale,
      currentGeneration: 4,
      requestGeneration: 4,
    })).toBe(false);
    expect(missionRequestIsCurrent({
      currentController: current,
      requestController: current,
      currentGeneration: 5,
      requestGeneration: 4,
    })).toBe(false);
    current.abort();
    expect(missionRequestIsCurrent({
      currentController: current,
      requestController: current,
      currentGeneration: 4,
      requestGeneration: 4,
    })).toBe(false);
  });

  it("suppresses stale detail results across fetch sources", () => {
    expect(missionDetailRequestIsCurrent(7, 7)).toBe(true);
    expect(missionDetailRequestIsCurrent(8, 7)).toBe(false);
  });

  it("keeps base selection in the current collection and only re-proves absent deep rows", () => {
    expect(missionBaseSelection(
      [exactMission, retainedMission],
      "mission-removed",
      retainedMission.id,
    )).toBe(retainedMission.id);
    expect(missionBaseSelection([exactMission], retainedMission.id))
      .toBe(exactMission.id);
    expect(missionNeedsDeepExactReproof([retainedMission], retainedMission.id))
      .toBe(false);
    expect(missionNeedsDeepExactReproof([retainedMission], exactMission.id))
      .toBe(true);
    expect(missionRouteSelection(
      [exactMission, retainedMission],
      "mission-removed",
      retainedMission.id,
    )).toBe("");
    expect(missionRouteSelection(
      [exactMission, retainedMission],
      exactMission.id,
      retainedMission.id,
    )).toBe(exactMission.id);
    expect(missionRouteAfterReproof(
      [exactMission, retainedMission],
      "mission-removed",
      retainedMission.id,
      true,
    )).toEqual({
      selectedId: retainedMission.id,
      replacePath: "/app/missions",
    });
  });

  it("fails closed for event authorization loss and invalid detail", () => {
    expect(missionEventFailureClosesRow({ status: 401 })).toBe(true);
    expect(missionEventFailureClosesRow({ status: 403 })).toBe(true);
    expect(missionEventFailureClosesRow({ status: 404 })).toBe(true);
    expect(missionEventFailureClosesRow({ invalidDetail: true })).toBe(true);
    expect(missionEventFailureClosesRow({ status: 503 })).toBe(false);
    expect(missionFailureClearsCollection(401)).toBe(true);
    expect(missionFailureClearsCollection(403)).toBe(true);
    expect(missionFailureClearsCollection(404)).toBe(false);
  });

  it("accepts exact detail only for the requested mission and scoped children", () => {
    const detail = {
      mission: exactMission,
      tasks: [{ id: "task-1", missionId: exactMission.id }],
      attempts: [{ id: "attempt-1", missionId: exactMission.id }],
      artifacts: [{ id: "artifact-1", missionId: exactMission.id }],
    };
    expect(missionDetailHasExpectedId(detail, exactMission.id)).toBe(true);
    expect(missionDetailHasExpectedId(detail, "mission-other")).toBe(false);
    expect(missionDetailHasExpectedId({
      ...detail,
      tasks: [{ id: "task-1", missionId: "mission-other" }],
    }, exactMission.id)).toBe(false);
    const normalized = normalizeMissionDetail({
      ...detail,
      tenantId: "top-level-secret",
      mission: { ...exactMission, actorId: "nested-secret" },
    }, exactMission.id);
    expect(normalized).toEqual(detail);
    expect(normalized).not.toHaveProperty("tenantId");
    expect(normalized?.mission).not.toHaveProperty("actorId");
  });

  it("server-renders retained continuity without exact detail or action surfaces", () => {
    const html = renderToStaticMarkup(createElement(MissionSummaryOnly, {
      mission: retainedMission,
      mode: "retained",
      asOf: Date.parse("2026-09-05T01:05:00.000Z"),
    }));

    expect(html).toContain("Read-only retained mission");
    expect(html).toContain("Retained planning history");
    expect(html).toContain("remains visible for continuity");
    expect(html).not.toContain("Ledger live");
    expect(html).not.toContain("Continue in Command");
    expect(html).not.toContain("New task");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });
});
