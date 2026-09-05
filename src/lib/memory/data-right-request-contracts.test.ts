import { describe, expect, it } from "vitest";

import {
  buildMemoryDataRightRequestEventV1,
  parseMemoryDataRightRequestRecordV1,
} from "@/lib/memory/data-right-request-contracts";

const ACTOR = "actor:00000000-0000-4000-8000-000000000001";

describe("memory data-right request contracts", () => {
  it("requires one exact human principal and purpose-specific confirmation", () => {
    expect(parseMemoryDataRightRequestRecordV1(requestRecord())).toMatchObject({
      purposeId: "memory.forget.v1",
      confirmationKind: "reviewed_deletion_preview",
      executingPrincipalType: "user",
    });
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      confirmationKind: "explicit_export_request",
    })).toThrow(/confirmation/i);
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      executingPrincipalId: "actor:00000000-0000-4000-8000-000000000002",
    })).toThrow(/subject actor/i);
  });

  it("requires canonical resources and a bounded validity window", () => {
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      resourceIds: ["memory:b", "memory:a"],
    })).toThrow(/sorted and unique/i);
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      expiresAt: "2026-09-05T09:00:00.000Z",
    })).toThrow(/timestamps/i);
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      expiresAt: "2026-09-05T10:00:00.001Z",
    })).toThrow(/timestamps/i);
  });

  it("permits only held, active, one-time consumed, or revoked lifecycles", () => {
    expect(parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      state: "active",
      lifecycleRevision: 1,
      activatedByActorId: ACTOR,
      activatedAt: "2026-09-05T09:15:00.000Z",
      updatedAt: "2026-09-05T09:15:00.000Z",
    }).state).toBe("active");
    expect(parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      state: "consumed",
      lifecycleRevision: 2,
      activatedByActorId: ACTOR,
      consumedByActorId: ACTOR,
      activatedAt: "2026-09-05T09:15:00.000Z",
      consumedAt: "2026-09-05T09:16:00.000Z",
      updatedAt: "2026-09-05T09:16:00.000Z",
    }).state).toBe("consumed");
    expect(() => parseMemoryDataRightRequestRecordV1({
      ...requestRecord(),
      state: "consumed",
      lifecycleRevision: 1,
      consumedByActorId: ACTOR,
      consumedAt: "2026-09-05T09:16:00.000Z",
      updatedAt: "2026-09-05T09:16:00.000Z",
    })).toThrow(/lifecycle/i);
  });

  it("emits metadata-only lifecycle evidence", () => {
    const event = buildMemoryDataRightRequestEventV1(
      requestRecord(),
      "governance:data-right-request",
    );
    expect(event).toMatchObject({
      type: "memory.data_right_request.held",
      payload: {
        requestId: "memory-data-right-request:one",
        resourceCount: 1,
        decisionActorId: ACTOR,
      },
    });
    expect(event.payload.resourceSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(event.payload).not.toHaveProperty("resourceIds");
  });
});

function requestRecord() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    requestId: "memory-data-right-request:one",
    requestGeneration: 1,
    purposeId: "memory.forget.v1",
    subjectActorId: ACTOR,
    executingPrincipalType: "user",
    executingPrincipalId: ACTOR,
    confirmationKind: "reviewed_deletion_preview",
    requestBindingSha256: "a".repeat(64),
    resourceIds: ["memory:one"],
    notBefore: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-05T10:00:00.000Z",
    state: "held",
    lifecycleRevision: 0,
    createdByActorId: ACTOR,
    activatedByActorId: null,
    consumedByActorId: null,
    revokedByActorId: null,
    createdAt: "2026-09-05T09:00:00.000Z",
    activatedAt: null,
    consumedAt: null,
    revokedAt: null,
    updatedAt: "2026-09-05T09:00:00.000Z",
  } as const;
}
