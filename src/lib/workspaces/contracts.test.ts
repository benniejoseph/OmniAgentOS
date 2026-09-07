import { describe, expect, it } from "vitest";
import {
  buildCanonicalWorkEventV1,
  parseCanonicalWorkCompatibilityV1,
  parseCanonicalWorkItemV1,
  parseCanonicalWorkspaceV1,
  personalWorkspaceId,
} from "@/lib/workspaces/contracts";

const now = "2026-09-07T12:00:00.000Z";
const actorId = "actor:123e4567-e89b-42d3-a456-426614174000";
const workspaceId = personalWorkspaceId(actorId);

describe("canonical Workspace -> Project -> WorkItem contracts", () => {
  it("derives the stable personal Workspace identity from a canonical actor", () => {
    expect(workspaceId).toBe("workspace:personal:123e4567-e89b-42d3-a456-426614174000");
    expect(() => personalWorkspaceId("person@example.com")).toThrow();
  });

  it("accepts a bounded WorkItem with every P10.1 planning coordinate", () => {
    const workItem = parseCanonicalWorkItemV1({
      schemaVersion: 1,
      tenantId: "tenant-a",
      workspaceId,
      projectId: "project-a",
      workItemId: "work-item-a",
      parentWorkItemId: null,
      kind: "milestone",
      canonicalStatus: "waiting",
      statusRevision: 1,
      sourceAuthority: "legacy_project_task",
      dependencyWorkItemIds: ["work-item-0"],
      ownerActorIds: [actorId],
      assignedAgents: [{
        agentId: "atlas",
        principalId: "agent:atlas",
        principalGeneration: 1,
      }],
      schedule: { startsAt: null, dueAt: now, timeZone: "Asia/Kolkata" },
      recurrence: { rrule: "FREQ=WEEKLY", startsAt: now, endsAt: null, maxOccurrences: 12 },
      risks: [{ riskId: "risk-a", severity: "high", state: "open", evidenceRefIds: [] }],
      decisions: [{ decisionId: "decision-a", state: "accepted", evidenceRefIds: [] }],
      artifacts: [{ artifactId: "artifact-a", kind: "document", evidenceRefIds: [] }],
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    });
    expect(workItem.kind).toBe("milestone");
    expect(workItem.assignedAgents[0]?.principalId).toBe("agent:atlas");
  });

  it("fails closed for ambiguous mappings and invalid terminal claims", () => {
    expect(() => parseCanonicalWorkCompatibilityV1({
      schemaVersion: 1,
      tenantId: "tenant-a",
      mappingId: "mapping-a",
      sourceKind: "legacy_project_task",
      sourceId: "task-a",
      sourceOwnerActorId: "person@example.com",
      canonicalOwnerActorId: null,
      workspaceId: null,
      projectId: null,
      workItemId: null,
      state: "active",
      quarantineCode: null,
      sourceRevisionSha256: "a".repeat(64),
      mappingRevision: 1,
      createdAt: now,
      updatedAt: now,
    })).toThrow();

    expect(() => parseCanonicalWorkItemV1({
      schemaVersion: 1,
      tenantId: "tenant-a",
      workspaceId,
      projectId: "project-a",
      workItemId: "work-item-a",
      parentWorkItemId: null,
      kind: "task",
      canonicalStatus: "succeeded",
      statusRevision: 1,
      sourceAuthority: "legacy_project_task",
      dependencyWorkItemIds: [],
      ownerActorIds: [actorId],
      assignedAgents: [],
      schedule: { startsAt: null, dueAt: null, timeZone: null },
      recurrence: null,
      risks: [],
      decisions: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    })).toThrow();
  });

  it("builds metadata-only digest-bound events", () => {
    const event = buildCanonicalWorkEventV1({
      tenantId: "tenant-a",
      workspaceId,
      projectId: "project-a",
      workItemId: "work-item-a",
      actorId,
      eventType: "work.item.status_changed",
      status: "running",
      revision: 2,
      changedFieldIds: ["status", "status"],
      sourceRevisionSha256: "b".repeat(64),
      occurredAt: now,
    });
    expect(event.changedFieldIds).toEqual(["status"]);
    expect(JSON.stringify(event)).not.toContain("private task content");
  });

  it("keeps workspace lifecycle internally consistent", () => {
    expect(() => parseCanonicalWorkspaceV1({
      schemaVersion: 1,
      tenantId: "tenant-a",
      workspaceId,
      displayName: "Personal workspace",
      state: "active",
      ownerActorId: actorId,
      lifecycleRevision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    })).toThrow();
  });
});
