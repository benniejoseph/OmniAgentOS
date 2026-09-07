import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalGrantRequest } from "@/lib/approval-grants/contracts";
import {
  claimApprovalGrant,
  issueApprovalGrant,
  listApprovalGrants,
  revokeApprovalGrantsForPlan,
} from "@/lib/approval-grants/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

let dataDir = "";
let priorDatabaseUrl: string | undefined;
let priorDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-approval-grants-"));
  priorDatabaseUrl = process.env.DATABASE_URL;
  priorDataDir = process.env.OMNIAGENT_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDataDir === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = priorDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("P9.4 approval grant store", () => {
  it("issues idempotently and consumes inside an exact bounded budget", async () => {
    const executionScope = scope("tenant-a", "alice", "workflow:run-one");
    const input = {
      ...request(),
      approvedByActorId: "alice",
      sourceApprovalId: "workflow-event-one",
      approvedAt: "2026-09-07T04:00:00.000Z",
      maxUses: 2,
    };
    const first = await issueApprovalGrant(input, { executionScope });
    const retry = await issueApprovalGrant(input, { executionScope });
    expect(first.created).toBe(true);
    expect(retry).toEqual({ grant: first.grant, created: false });

    const one = await claimApprovalGrant({
      grantId: first.grant.grantId,
      request: request(),
      executionKey: "node-one",
      now: "2026-09-07T04:01:00.000Z",
    }, { executionScope });
    expect(one).toMatchObject({
      outcome: "claimed",
      grant: { state: "active", usedUses: 1, maxUses: 2 },
      claim: { useOrdinal: 1 },
    });
    await expect(claimApprovalGrant({
      grantId: first.grant.grantId,
      request: request(),
      executionKey: "node-one",
      now: "2026-09-07T04:02:00.000Z",
    }, { executionScope })).resolves.toMatchObject({
      outcome: "existing",
      claim: { useOrdinal: 1 },
    });
    await expect(claimApprovalGrant({
      grantId: first.grant.grantId,
      request: request(),
      executionKey: "node-two",
      now: "2026-09-07T04:03:00.000Z",
    }, { executionScope })).resolves.toMatchObject({
      outcome: "claimed",
      grant: { state: "exhausted", usedUses: 2 },
      claim: { useOrdinal: 2 },
    });
    await expect(claimApprovalGrant({
      grantId: first.grant.grantId,
      request: request(),
      executionKey: "node-three",
      now: "2026-09-07T04:04:00.000Z",
    }, { executionScope })).resolves.toMatchObject({
      outcome: "denied",
      reason: "budget_exhausted",
    });
  });

  it("does not cross actor, principal, plan, contract, target, or expiry boundaries", async () => {
    const executionScope = scope("tenant-a", "alice", "workflow:run-one");
    const issued = await issueApprovalGrant({
      ...request(),
      approvedByActorId: "alice",
      sourceApprovalId: "workflow-event-one",
      approvedAt: "2026-09-07T04:00:00.000Z",
      maxUses: 2,
    }, { executionScope });
    for (const changed of [
      request({ planSha256: "d".repeat(64) }),
      request({ toolContractSha256: "e".repeat(64) }),
      request({ targetSha256: "f".repeat(64) }),
    ]) {
      await expect(claimApprovalGrant({
        grantId: issued.grant.grantId,
        request: changed,
        executionKey: JSON.stringify(changed),
        now: "2026-09-07T04:01:00.000Z",
      }, { executionScope })).resolves.toMatchObject({
        outcome: "denied",
        reason: "binding_changed",
      });
    }
    await expect(claimApprovalGrant({
      grantId: issued.grant.grantId,
      request: request(),
      executionKey: "late",
      now: "2026-09-07T05:00:00.000Z",
    }, { executionScope })).resolves.toMatchObject({
      outcome: "denied",
      reason: "expired",
    });
    await expect(listApprovalGrants({
      executionScope: scope("tenant-a", "bob", "workflow:run-one"),
    })).resolves.toEqual([]);
    await expect(issueApprovalGrant({
      ...request(),
      ownerActorId: "bob",
      approvedByActorId: "alice",
      sourceApprovalId: "workflow-event-two",
      approvedAt: "2026-09-07T04:00:00.000Z",
      maxUses: 1,
    }, { executionScope })).rejects.toThrow(/execution scope/);
  });

  it("revokes old-plan authority on replanning without touching another plan", async () => {
    const executionScope = scope("tenant-a", "alice", "workflow:run-one");
    const first = await issueApprovalGrant({
      ...request(),
      approvedByActorId: "alice",
      sourceApprovalId: "workflow-event-one",
      approvedAt: "2026-09-07T04:00:00.000Z",
      maxUses: 2,
    }, { executionScope });
    await issueApprovalGrant({
      ...request({ planId: "plan-two", planSha256: "d".repeat(64) }),
      approvedByActorId: "alice",
      sourceApprovalId: "workflow-event-two",
      approvedAt: "2026-09-07T04:00:00.000Z",
      maxUses: 1,
    }, { executionScope });

    const revoked = await revokeApprovalGrantsForPlan({
      planId: "plan-one",
      planSha256: "a".repeat(64),
      now: "2026-09-07T04:10:00.000Z",
    }, { executionScope });
    expect(revoked).toMatchObject([{ grantId: first.grant.grantId, state: "revoked" }]);
    const grants = await listApprovalGrants({ executionScope });
    expect(grants.find((grant) => grant.planId === "plan-one")?.state).toBe("revoked");
    expect(grants.find((grant) => grant.planId === "plan-two")?.state).toBe("active");
  });
});

function request(overrides: Partial<ApprovalGrantRequest> = {}): ApprovalGrantRequest {
  return {
    tenantId: "tenant-a",
    ownerActorId: "alice",
    executingPrincipalType: "system",
    executingPrincipalId: "workflow:run-one",
    planId: "plan-one",
    planSha256: "a".repeat(64),
    domain: "connector",
    actionClass: "connector.demo.create",
    toolId: "connector.demo.create",
    toolContractSha256: "b".repeat(64),
    targetSha256: "c".repeat(64),
    riskLevel: 2,
    reversible: true,
    ...overrides,
  };
}

function scope(tenantId: string, actorId: string, principalId: string) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "system",
    executingPrincipalId: principalId,
    correlationId: `approval-grant:${tenantId}:${actorId}`,
    purpose: "Test bounded approval grants.",
  });
}
