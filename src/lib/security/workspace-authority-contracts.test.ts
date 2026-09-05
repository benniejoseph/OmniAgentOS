import { describe, expect, it } from "vitest";

import {
  buildWorkspaceAuthorityEventV1,
  buildWorkspaceMembershipEventV1,
  parseWorkspaceAuthorityRecordV1,
  parseWorkspaceMembershipRecordV1,
} from "@/lib/security/workspace-authority-contracts";

const ACTOR = "actor:00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-05T10:00:00.000Z";

describe("workspace authority contracts", () => {
  it("parses a held workspace without inferring tenant membership", () => {
    const workspace = parseWorkspaceAuthorityRecordV1(workspaceRecord());
    expect(workspace).toMatchObject({ workspaceId: "workspace:product", state: "held" });
    expect(buildWorkspaceAuthorityEventV1(workspace, "governance:workspace-hold").type)
      .toBe("security.workspace.held");
  });

  it("keeps human and execution-principal membership identities disjoint", () => {
    const user = parseWorkspaceMembershipRecordV1(membershipRecord());
    const agent = parseWorkspaceMembershipRecordV1({
      ...membershipRecord(),
      subjectKind: "agent",
      subjectKey: "agent:researcher",
      subjectActorId: null,
      subjectExecutionPrincipalId: "agent:researcher",
      subjectExecutionPrincipalGeneration: 1,
    });
    expect(user.subjectActorId).toBe(ACTOR);
    expect(agent.subjectExecutionPrincipalId).toBe("agent:researcher");
    expect(() => parseWorkspaceMembershipRecordV1({
      ...membershipRecord(),
      subjectKind: "agent",
      subjectExecutionPrincipalId: "agent:researcher",
      subjectExecutionPrincipalGeneration: 1,
    })).toThrow(/subject/i);
  });

  it("rejects unsupported roles and impossible active state", () => {
    expect(() => parseWorkspaceMembershipRecordV1({
      ...membershipRecord(),
      accessLevel: "administrator",
    })).toThrow();
    expect(() => parseWorkspaceMembershipRecordV1({
      ...membershipRecord(),
      state: "active",
      lifecycleRevision: 1,
    })).toThrow(/lifecycle/i);
  });

  it("builds metadata-only membership lifecycle events", () => {
    const membership = parseWorkspaceMembershipRecordV1(membershipRecord());
    expect(buildWorkspaceMembershipEventV1(
      membership,
      "governance:workspace-membership-hold",
    )).toMatchObject({
      type: "security.workspace_membership.held",
      payload: {
        tenantId: "tenant:one",
        workspaceId: "workspace:product",
        subjectKind: "user",
        subjectKey: ACTOR,
        accessLevel: "reader",
      },
    });
  });
});

function workspaceRecord() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    workspaceId: "workspace:product",
    state: "held",
    lifecycleRevision: 0,
    createdByActorId: ACTOR,
    activatedByActorId: null,
    archivedByActorId: null,
    createdAt: CREATED_AT,
    activatedAt: null,
    archivedAt: null,
    updatedAt: CREATED_AT,
  } as const;
}

function membershipRecord() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    workspaceId: "workspace:product",
    subjectKind: "user",
    subjectKey: ACTOR,
    subjectActorId: ACTOR,
    subjectExecutionPrincipalId: null,
    subjectExecutionPrincipalGeneration: null,
    membershipGeneration: 1,
    accessLevel: "reader",
    state: "held",
    lifecycleRevision: 0,
    createdByActorId: ACTOR,
    activatedByActorId: null,
    revokedByActorId: null,
    createdAt: CREATED_AT,
    activatedAt: null,
    revokedAt: null,
    updatedAt: CREATED_AT,
  } as const;
}
