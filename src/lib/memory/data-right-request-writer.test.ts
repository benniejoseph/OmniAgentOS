import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  recordHeldMemoryDataRightRequestV1,
  type MemoryDataRightRequestWriterSql,
} from "@/lib/memory/data-right-request-writer";
import { createExecutionScope } from "@/lib/security/execution-scope";

const TENANT_ID = "tenant:data-right-writer";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = `actor:${USER_ID}`;
const OBSERVED_AT = "2026-09-05T09:00:00.000Z";
const REQUEST_ID = "memory-data-right-request:writer-one";
const REQUEST_SHA256 = "a".repeat(64);

describe("held memory data-right request writer", () => {
  beforeEach(() => {
    eventMocks.appendScopedDomainEvent.mockReset();
    eventMocks.appendScopedDomainEvent.mockImplementation(async (input) => ({
      id: input.id,
      seq: 17,
      streamId: input.streamId,
      type: input.type,
      tenantId: input.executionScope.tenantId,
      actorId: input.executionScope.initiatingActorId,
      payload: input.payload,
      correlationId: input.executionScope.correlationId,
      executionScope: input.executionScope,
      at: OBSERVED_AT,
    }));
  });

  it("persists one held request and metadata-only event in the supplied transaction", async () => {
    const { sql, calls } = fakeWriterSql();

    const result = await recordHeldMemoryDataRightRequestV1(
      {
        executionScope: requestScope(),
        request: heldRequest(),
        governanceDecisionId: "governance:data-right-request",
      },
      sql,
    );

    expect(result.request).toMatchObject({
      tenantId: TENANT_ID,
      requestId: REQUEST_ID,
      purposeId: "memory.forget.v1",
      subjectActorId: ACTOR_ID,
      state: "held",
      lifecycleRevision: 0,
    });
    expect(result.authorityGranted).toBe(false);
    expect(result.runtimeAccepted).toBe(false);
    expect(calls.map((call) => call.label)).toEqual([
      "preflight",
      "user",
      "membership",
      "request",
    ]);
    expect(calls[0]?.text).toContain("version = 64");
    expect(calls[0]?.text).toContain(
      "omni_memory_data_right_request_activation_hold_check",
    );
    expect(calls[1]?.text).toContain("LIMIT 2 FOR SHARE");
    expect(calls[2]?.text).toContain("LIMIT 2 FOR SHARE");
    expect(calls[3]?.params).toEqual([
      1,
      TENANT_ID,
      REQUEST_ID,
      1,
      "memory.forget.v1",
      ACTOR_ID,
      "user",
      ACTOR_ID,
      "reviewed_deletion_preview",
      REQUEST_SHA256,
      ["memory:one"],
      "2026-09-05T08:30:00.000Z",
      "2026-09-05T09:30:00.000Z",
      ACTOR_ID,
    ]);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^memory-data-right-request-held:[0-9a-f]{64}$/),
        streamId: expect.stringMatching(/^memory-data-right-request:[0-9a-f]{64}$/),
        type: "memory.data_right_request.held",
        executionScope: requestScope(),
        payload: expect.objectContaining({
          requestId: REQUEST_ID,
          resourceCount: 1,
          governanceDecisionId: "governance:data-right-request",
        }),
      }),
      { sql },
    );
    const eventInput = eventMocks.appendScopedDomainEvent.mock.calls[0]?.[0];
    expect(eventInput.payload).not.toHaveProperty("resourceIds");
  });

  it("rejects a non-transaction client before any database or event work", async () => {
    const { sql, calls } = fakeWriterSql({ transactionScoped: false });

    await expect(recordHeldMemoryDataRightRequestV1(
      {
        executionScope: requestScope(),
        request: heldRequest(),
        governanceDecisionId: "governance:data-right-request",
      },
      sql,
    )).rejects.toThrow(/existing database transaction/i);

    expect(calls).toEqual([]);
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("requires exact human request attribution before preflight", async () => {
    const { sql, calls } = fakeWriterSql();
    const agentScope = createExecutionScope({
      ...requestScope(),
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:asael",
    });

    await expect(recordHeldMemoryDataRightRequestV1(
      {
        executionScope: agentScope,
        request: heldRequest(),
        governanceDecisionId: "governance:data-right-request",
      },
      sql,
    )).rejects.toThrow(/exact held human request scope/i);

    expect(calls).toEqual([]);
  });

  it("fails closed before insert for invalid owner scope or membership", async () => {
    for (const variant of ["preflight", "membership"] as const) {
      const { sql, calls } = fakeWriterSql({ variant });

      await expect(recordHeldMemoryDataRightRequestV1(
        {
          executionScope: requestScope(),
          request: heldRequest(),
          governanceDecisionId: "governance:data-right-request",
        },
        sql,
      )).rejects.toThrow(
        variant === "preflight" ? /preflight failed closed/i : /membership is unavailable/i,
      );

      expect(calls.some((call) => call.label === "request")).toBe(false);
      expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
    }
  });

  it("rejects a valid but differently bound returned request before its event", async () => {
    const { sql } = fakeWriterSql({ variant: "returned_binding" });

    await expect(recordHeldMemoryDataRightRequestV1(
      {
        executionScope: requestScope(),
        request: heldRequest(),
        governanceDecisionId: "governance:data-right-request",
      },
      sql,
    )).rejects.toThrow(/persisted memory data-right request binding changed/i);

    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});

function requestScope() {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId: ACTOR_ID,
    executingPrincipalType: "user",
    executingPrincipalId: ACTOR_ID,
    correlationId: "correlation:data-right-writer",
    purpose: "memory.forget.v1",
  });
}

function heldRequest() {
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    requestGeneration: 1,
    purposeId: "memory.forget.v1",
    subjectActorId: ACTOR_ID,
    executingPrincipalType: "user",
    executingPrincipalId: ACTOR_ID,
    confirmationKind: "reviewed_deletion_preview",
    requestBindingSha256: REQUEST_SHA256,
    resourceIds: ["memory:one"],
    notBefore: "2026-09-05T08:30:00.000Z",
    expiresAt: "2026-09-05T09:30:00.000Z",
    state: "held",
    lifecycleRevision: 0,
    createdByActorId: ACTOR_ID,
    activatedByActorId: null,
    consumedByActorId: null,
    revokedByActorId: null,
    createdAt: "2026-09-05T08:00:00.000Z",
    activatedAt: null,
    consumedAt: null,
    revokedAt: null,
    updatedAt: "2026-09-05T08:00:00.000Z",
  } as const;
}

function fakeWriterSql(options: {
  transactionScoped?: boolean;
  variant?: "preflight" | "membership" | "returned_binding";
} = {}) {
  const calls: Array<{ label: string; text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT current_user")) {
      calls.push({ label: "preflight", text: normalized, params });
      return [{
        schema_owner: options.variant !== "preflight",
        tenant_id: null,
        system_scope: true,
        request_schema_valid: true,
        activation_hold_valid: true,
        request_boundary_valid: true,
      }];
    }
    if (normalized.includes("FROM omni_auth_users")) {
      calls.push({ label: "user", text: normalized, params });
      return [{ id: USER_ID, actor_id: ACTOR_ID, status: "active" }];
    }
    if (normalized.includes("FROM omni_auth_memberships")) {
      calls.push({ label: "membership", text: normalized, params });
      return [{
        id: "membership:data-right-writer",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        status: options.variant === "membership" ? "suspended" : "active",
      }];
    }
    if (normalized.startsWith(
      "INSERT INTO omni_tenant_memory_data_right_requests",
    )) {
      calls.push({ label: "request", text: normalized, params });
      return [persistedRequestRow(
        options.variant === "returned_binding"
          ? { request_id: "memory-data-right-request:different" }
          : {},
      )];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const tagged = vi.fn(async () => []);
  const sql = Object.assign(tagged, {
    query,
    unsafe: vi.fn(async () => []),
    transaction: vi.fn(),
    transactionScoped: options.transactionScoped ?? true,
  }) as MemoryDataRightRequestWriterSql;
  return { sql, calls };
}

function persistedRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    tenant_id: TENANT_ID,
    request_id: REQUEST_ID,
    request_generation: "1",
    purpose_id: "memory.forget.v1",
    subject_actor_id: ACTOR_ID,
    executing_principal_type: "user",
    executing_principal_id: ACTOR_ID,
    confirmation_kind: "reviewed_deletion_preview",
    request_binding_sha256: REQUEST_SHA256,
    resource_ids: ["memory:one"],
    not_before: new Date(OBSERVED_AT),
    expires_at: new Date("2026-09-05T09:30:00.000Z"),
    state: "held",
    lifecycle_revision: "0",
    created_by_actor_id: ACTOR_ID,
    activated_by_actor_id: null,
    consumed_by_actor_id: null,
    revoked_by_actor_id: null,
    created_at: new Date(OBSERVED_AT),
    activated_at: null,
    consumed_at: null,
    revoked_at: null,
    updated_at: new Date(OBSERVED_AT),
    ...overrides,
  };
}
