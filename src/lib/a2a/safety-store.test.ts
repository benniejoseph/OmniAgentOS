import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasDatabaseUrl: vi.fn(() => true),
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  claimExternalA2AToolCall,
  listAbandonedExternalA2ASafety,
  reserveExternalA2ASafety,
} from "@/lib/a2a/safety-store";
import { buildA2ASafetyReservationV1 } from "@/lib/a2a/safety";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { buildDelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("external A2A safety store", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.ensureDatabaseSchema.mockResolvedValue(undefined);
    mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  });

  it("serializes a root reservation and persists its typed safety event", async () => {
    let persisted: Record<string, unknown> | undefined;
    const sql = database(async (statement, values) => {
      if (/FROM omni_a2a_safety_reservations/.test(statement) && /LIMIT 1/.test(statement)) {
        return [];
      }
      if (/pg_advisory_xact_lock/.test(statement)) return [];
      if (/active_sibling_count/.test(statement)) {
        return [{
          active_sibling_count: 0,
          active_root_task_count: 0,
          active_root_reserved_cost: 0,
        }];
      }
      if (/INSERT INTO omni_a2a_safety_reservations/.test(statement)) {
        const reservation = values.find((value) =>
          Boolean(value) && typeof value === "object" &&
          (value as { version?: string }).version === "p8.7-a2a-safety-reservation:1"
        );
        persisted = row(reservation as never);
        return [persisted];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.getSql.mockReturnValue(sql);

    const contract = buildContract();
    const state = await reserveExternalA2ASafety({
      contract,
      internalTask: buildDelegationTaskV1(contract),
      rollout: rollout(),
      executionScope: parentScope,
      now: "2026-09-07T06:00:30.000Z",
    });

    expect(state).toMatchObject({
      status: "active",
      toolCallsUsed: 0,
      reservation: {
        rootDelegationId: "delegation:one",
        trustTier: "external_untrusted",
      },
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "a2a.safety.reserved" }),
      { sql },
    );
    expect(persisted).toBeDefined();
  });

  it("charges a governed tool call once for an idempotency key", async () => {
    let state = row(reservation());
    let claimed = false;
    const sql = database(async (statement) => {
      if (/FROM omni_a2a_safety_reservations/.test(statement) && /FOR UPDATE/.test(statement)) {
        return [state];
      }
      if (/SELECT claim_id FROM omni_a2a_tool_call_claims/.test(statement)) {
        return claimed ? [{ claim_id: "existing" }] : [];
      }
      if (/INSERT INTO omni_a2a_tool_call_claims/.test(statement)) {
        claimed = true;
        return [];
      }
      if (/UPDATE omni_a2a_safety_reservations/.test(statement)) {
        state = {
          ...state,
          tool_calls_used: 1,
          progress_revision: 1,
          last_progress_at: "2026-09-07T06:00:31.000Z",
        };
        return [state];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.getSql.mockReturnValue(sql);
    const request = {
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      internalTaskId: "delegation-task:one",
      toolId: "knowledge.search",
      idempotencyKey: "remote-call:one",
      executionScope: parentScope,
      now: "2026-09-07T06:00:31.000Z",
    };

    await expect(claimExternalA2AToolCall(request)).resolves.toMatchObject({
      charged: true,
      state: { toolCallsUsed: 1 },
    });
    await expect(claimExternalA2AToolCall(request)).resolves.toMatchObject({
      charged: false,
      state: { toolCallsUsed: 1 },
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
  });

  it("returns only bounded stale or deadline-expired reservations", async () => {
    const expected = row(reservation());
    const sql = database(async (statement) => {
      expect(statement).toContain("progress_timeout_ms * INTERVAL '1 millisecond'");
      expect(statement).toContain("LIMIT");
      return [expected];
    });
    mocks.getSql.mockReturnValue(sql);
    await expect(listAbandonedExternalA2ASafety({
      tenantId: "tenant-one",
      limit: 100,
      now: "2026-09-07T06:02:01.000Z",
    })).resolves.toMatchObject([{ reservation: { safetyId: reservation().safetyId } }]);
  });
});

function reservation() {
  return buildA2ASafetyReservationV1({
    contract: buildContract(),
    internalTaskId: "delegation-task:one",
    rollout: rollout(),
    lineage: {
      ancestorDelegationIds: [],
      ancestorPeerIds: [],
      rootDelegationId: "delegation:one",
      activeSiblingCount: 0,
      activeRootTaskCount: 0,
      activeRootReservedCostMicrousd: 0,
    },
    createdAt: "2026-09-07T06:00:30.000Z",
  });
}

function row(value: ReturnType<typeof reservation>) {
  return {
    reservation: value,
    status: "active",
    tool_calls_used: 0,
    progress_revision: 0,
    last_progress_at: "2026-09-07T06:00:30.000Z",
    terminal_at: null,
  };
}

function rollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildA2APeerRolloutV1({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      peerId: "peer:one",
      generation: 1,
      direction: "outbound",
      mode: "enabled",
      interfaceUrl: "https://peer.example/a2a/",
      agentCardSha256: "d".repeat(64),
      outboundCredentialConfigured: true,
      allowedSkillIds: ["peer.verify"],
      createdAt: "2026-09-07T06:00:00.000Z",
    }),
    to: "active",
    at: "2026-09-07T06:00:01.000Z",
  });
}

const parentScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  delegationId: null,
  correlationId: "correlation:one",
  purpose: "test external safety",
});

function database(
  handler: (statement: string, values: unknown[]) => Promise<Record<string, unknown>[]>,
) {
  const sql = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => handler(strings.join("?"), values)) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
    transaction: (callback: (transactionSql: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  sql.transaction = async (callback) => callback(sql);
  return sql;
}
