import { describe, expect, it } from "vitest";

import {
  assertExecutionPrincipalRecordEventBindingV1,
  buildExecutionPrincipalEventV1,
  parseExecutionPrincipalRecordV1,
} from "@/lib/security/execution-principal-contracts";

const ACTOR = "actor:00000000-0000-4000-8000-000000000001";
const OTHER_ACTOR = "actor:00000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-09-05T10:00:00.000Z";

describe("execution principal contracts", () => {
  it("separates an agent security principal from its definition", () => {
    const record = parseExecutionPrincipalRecordV1(agentRecord());

    expect(record).toMatchObject({
      principalKind: "agent",
      principalId: "agent:researcher",
      agentDefinitionId: "definition:researcher-v3",
      state: "held",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("requires actor-bound system principals to use a closed class", () => {
    expect(
      parseExecutionPrincipalRecordV1({
        ...agentRecord(),
        principalKind: "system",
        principalId: "service:workflow-runner",
        agentDefinitionId: null,
        systemPrincipalClass: "workflow",
      }),
    ).toMatchObject({
      principalKind: "system",
      systemPrincipalClass: "workflow",
    });
    expect(() =>
      parseExecutionPrincipalRecordV1({
        ...agentRecord(),
        principalKind: "system",
        principalId: "agent:researcher",
        agentDefinitionId: null,
        systemPrincipalClass: "administrator",
      }),
    ).toThrow();
  });

  it("rejects impossible lifecycle shapes and chronology", () => {
    expect(() =>
      parseExecutionPrincipalRecordV1({
        ...agentRecord(),
        state: "active",
        lifecycleRevision: 1,
      }),
    ).toThrow(/lifecycle fields/i);
    expect(() =>
      parseExecutionPrincipalRecordV1({
        ...agentRecord(),
        updatedAt: "2026-09-05T09:59:59.999Z",
      }),
    ).toThrow(/timestamps/i);
  });

  it("builds and binds metadata-only lifecycle events", () => {
    const record = parseExecutionPrincipalRecordV1(agentRecord());
    const event = buildExecutionPrincipalEventV1({
      tenantId: record.tenantId,
      principalKind: record.principalKind,
      principalId: record.principalId,
      principalGeneration: record.principalGeneration,
      controllerActorId: record.controllerActorId,
      agentDefinitionId: record.agentDefinitionId,
      systemPrincipalClass: record.systemPrincipalClass,
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId: record.createdByActorId,
      decisionAt: record.createdAt,
      governanceDecisionId: "governance:principal-hold",
    });

    expect(event.type).toBe("security.execution_principal.held");
    expect(
      assertExecutionPrincipalRecordEventBindingV1(record, event),
    ).toMatchObject({ record, event });
    expect(() =>
      assertExecutionPrincipalRecordEventBindingV1(record, {
        ...event,
        payload: { ...event.payload, decisionActorId: OTHER_ACTOR },
      }),
    ).toThrow(/decision attribution/i);
  });
});

function agentRecord() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    principalKind: "agent",
    principalId: "agent:researcher",
    principalGeneration: 1,
    controllerActorId: ACTOR,
    agentDefinitionId: "definition:researcher-v3",
    systemPrincipalClass: null,
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
