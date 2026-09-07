import { describe, expect, it } from "vitest";

import {
  approvalGrantClaimAuthorizes,
  approvalGrantExecutionKeySha256,
  buildToolApprovalGrantRequest,
} from "@/lib/approval-grants/authorization";
import {
  buildApprovalGrantClaimV1,
  buildApprovalGrantV1,
} from "@/lib/approval-grants/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ToolDefinition } from "@/lib/tools/types";

const now = "2026-09-07T04:10:00.000Z";
const executionKey = "workflow:run-one:plan:plan-one:node:node-one:tool:connector.demo";
const tool: ToolDefinition = {
  id: "connector.demo",
  name: "Demo connector",
  description: "Updates a reversible demo record.",
  category: "connector",
  status: "active",
  riskLevel: 2,
  dryRunSupported: true,
  approvalRequired: true,
  operationClass: "mutation",
  reversible: true,
  inputSchema: { type: "object", additionalProperties: false },
};
const executionScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "system",
  executingPrincipalId: "workflow:run-one",
  correlationId: "correlation-one",
  purpose: "Execute a workflow tool.",
});

describe("P9.4 governed-tool grant authorization", () => {
  it("binds the exact validated input and tool contract", () => {
    const one = buildToolApprovalGrantRequest({
      tool,
      toolInput: { recordId: "one", value: "A" },
      executionScope,
      planId: "plan-one",
      planSha256: "a".repeat(64),
    });
    const two = buildToolApprovalGrantRequest({
      tool,
      toolInput: { recordId: "one", value: "B" },
      executionScope,
      planId: "plan-one",
      planSha256: "a".repeat(64),
    });
    expect(one?.targetSha256).not.toBe(two?.targetSha256);
    expect(one?.toolContractSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only a live exact claim for its execution key", () => {
    const request = buildToolApprovalGrantRequest({
      tool,
      toolInput: { recordId: "one", value: "A" },
      executionScope,
      planId: "plan-one",
      planSha256: "a".repeat(64),
    })!;
    const grant = buildApprovalGrantV1({
      version: "p9.4-approval-grant:1",
      grantId: "grant:11111111-1111-4111-8111-111111111111",
      ...request,
      approvedByActorId: "approver-one",
      sourceApprovalId: "approval-one",
      issuedAt: "2026-09-07T04:00:00.000Z",
      expiresAt: "2026-09-07T05:00:00.000Z",
      maxUses: 2,
      usedUses: 1,
      state: "active",
      lifecycleRevision: 2,
      lastUsedAt: now,
      revokedAt: null,
    });
    const claim = buildApprovalGrantClaimV1({
      version: "p9.4-approval-grant-claim:1",
      claimId: "claim:22222222-2222-4222-8222-222222222222",
      grantId: grant.grantId,
      grantBindingSha256: grant.bindingSha256,
      tenantId: grant.tenantId,
      ownerActorId: grant.ownerActorId,
      executionKeySha256: approvalGrantExecutionKeySha256({
        tenantId: grant.tenantId,
        ownerActorId: grant.ownerActorId,
        executionKey,
      }),
      useOrdinal: 1,
      claimedAt: now,
    });
    expect(approvalGrantClaimAuthorizes({
      evidence: { grant, claim },
      request,
      executionKey,
      now: new Date(now),
    })).toBe(true);
    expect(approvalGrantClaimAuthorizes({
      evidence: { grant, claim },
      request,
      executionKey: `${executionKey}:changed`,
      now: new Date(now),
    })).toBe(false);
    expect(approvalGrantClaimAuthorizes({
      evidence: {
        grant: buildApprovalGrantV1({
          ...grant,
          state: "revoked",
          revokedAt: now,
          lifecycleRevision: 3,
        }),
        claim,
      },
      request,
      executionKey,
      now: new Date(now),
    })).toBe(false);
  });

  it("never creates grants for risk zero, risk three, or irreversible tools", () => {
    for (const changed of [
      { ...tool, riskLevel: 0 as const },
      { ...tool, riskLevel: 3 as const },
      { ...tool, reversible: false },
    ]) {
      expect(buildToolApprovalGrantRequest({
        tool: changed,
        toolInput: {},
        executionScope,
        planId: "plan-one",
        planSha256: "a".repeat(64),
      })).toBeUndefined();
    }
  });
});
