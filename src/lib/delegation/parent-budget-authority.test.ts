import { describe, expect, it } from "vitest";

import {
  buildParentDelegationBudgetAuthorityV1,
  parentDelegationAppServiceIdempotencyKey,
  resolveParentDelegationBudgetAuthority,
  withParentDelegationBudgetAuthority,
} from "@/lib/delegation/parent-budget-authority";
import {
  DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
  dynamicDelegationParentToolReservation,
  dynamicDelegationRootReservation,
} from "@/lib/delegation/runtime-policy";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  createRunBudgetState,
  reserveRunBudget,
} from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("parent delegation budget authority", () => {
  it("binds the model-loop reservation to the governed app-service execution identity", async () => {
    const fixture = authorityFixture({
      idempotencyKey: parentDelegationAppServiceIdempotencyKey({
        tenantId: "tenant-one",
        toolCallIdempotencyKey: "run-root:call-one",
      }),
    });

    await withParentDelegationBudgetAuthority(fixture.authority, async () => {
      expect(resolveParentDelegationBudgetAuthority({
        tenantId: "tenant-one",
        actorId: "actor-one",
        parentExecutionId: "run-root",
        parentPrincipalId: "principal:atlas:one",
        idempotencyKey:
          "idem_dfd35e2a4fc41b6fe3353bd4e02f96cf1a7c8ad5c91bbc8aac9f523e29211bc9",
      }).authoritySha256).toBe(fixture.authority.authoritySha256);
    });
  });

  it("binds one exact live parent reservation to scope and idempotency", async () => {
    const fixture = authorityFixture();

    await withParentDelegationBudgetAuthority(fixture.authority, async () => {
      const resolved = resolveParentDelegationBudgetAuthority({
        tenantId: "tenant-one",
        actorId: "actor-one",
        parentExecutionId: "run-root",
        parentPrincipalId: "principal:atlas:one",
        idempotencyKey: "delegation-call:one",
      });

      expect(resolved.authoritySha256).toBe(fixture.authority.authoritySha256);
      expect(resolved.parentBudgetUsedAfter.modelTurns).toBe(
        fixture.before.used.modelTurns +
          DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.modelTurns,
      );
      expect(resolved.parentBudgetUsedAfter.toolCalls).toBe(
        fixture.before.used.toolCalls +
          DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.toolCalls + 1,
      );
    });

    expect(() => resolveParentDelegationBudgetAuthority({
      tenantId: "tenant-one",
      actorId: "actor-one",
      parentExecutionId: "run-root",
      parentPrincipalId: "principal:atlas:one",
      idempotencyKey: "delegation-call:one",
    })).toThrow(/live parent-loop budget reservation/i);
  });

  it("fails closed when another idempotency identity tries to reuse it", () => {
    const { authority } = authorityFixture();
    expect(() => resolveParentDelegationBudgetAuthority({
      tenantId: "tenant-one",
      actorId: "actor-one",
      parentExecutionId: "run-root",
      parentPrincipalId: "principal:atlas:one",
      idempotencyKey: "delegation-call:other",
      explicit: authority,
    })).toThrow(/does not match/i);
  });
});

function authorityFixture(options: { idempotencyKey?: string } = {}) {
  const scope = createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "agent",
    executingPrincipalId: "principal:atlas:one",
    correlationId: "run-root",
    delegationId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "agent.run",
  });
  const reservedAt = "2026-09-22T12:00:00.000Z";
  const before = createRunBudgetState(DEFAULT_AGENT_RUN_BUDGET_LIMITS, {
    startedAt: reservedAt,
    used: {
      modelTurns: 1,
      tokens: 4_000,
      costMicrousd: 50_000,
      toolCalls: 2,
    },
  });
  const parentToolReservation = dynamicDelegationParentToolReservation();
  const after = reserveRunBudget(
    before,
    parentToolReservation,
    Date.parse(reservedAt),
  );
  return {
    before,
    authority: buildParentDelegationBudgetAuthorityV1({
      parentExecutionScope: scope,
      idempotencyKey: options.idempotencyKey || "delegation-call:one",
      before,
      after,
      childRootReservation: dynamicDelegationRootReservation(),
      parentToolReservation,
      reservedAt,
    }),
  };
}
