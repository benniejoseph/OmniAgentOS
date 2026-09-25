import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  approvalGrantTargetSha256,
  approvalGrantToolContractSha256,
} from "@/lib/approval-grants/authorization";
import { buildDataInfluenceManifestV1 } from "@/lib/security/data-influence";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildPolicyLeaseV1 } from "@/lib/security/policy-lease";
import { PolicyLeaseStoreError } from "@/lib/security/policy-lease-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { getGovernedTool } from "@/lib/tools/registry";

const audit = vi.hoisted(() => ({
  claimIdempotentToolExecution: vi.fn(),
}));

vi.mock("@/lib/tools/audit-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tools/audit-store")>(),
  claimIdempotentToolExecution: audit.claimIdempotentToolExecution,
}));

describe("scheduled PolicyLease governed execution", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-policy-lease-fallback-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
  });

  it("falls back to the same bound approval without invoking the effect", async () => {
    const tenantId = "tenant-policy-lease";
    const actorId = "owner-policy-lease";
    const principalId = "agent:scheduled-policy-lease:g1";
    const idempotencyKey = "workflow:run-lease:plan:plan-1:node:node-1:tool:calendar.create";
    const connectionId = "3c9e1f7a-5b2d-4a6c-8e1f-7d3b5a9c2e4f";
    const input = {
      connectionId,
      calendarId: "primary",
      summary: "Reviewed scheduled session",
      description: "Exact static input under review.",
      start: "2026-09-23T10:00:00.000Z",
      end: "2026-09-23T11:00:00.000Z",
    };
    const tool = getGovernedTool("calendar.create");
    expect(tool).toBeDefined();
    const executionId = `idem_${createHash("sha256")
      .update(`${tenantId}\u0000${idempotencyKey}`)
      .digest("hex")}`;
    const policySha256 = "1".repeat(64);
    const modelInfluenceSha256 = canonicalJsonSha256({
      workflowRunId: "workflow-run-lease",
      planId: "plan-1",
      nodeId: "node-1",
    });
    const influenceManifest = buildDataInfluenceManifestV1({
      tenantId,
      runId: "workflow-run-lease",
      executionId,
      principalId,
      createdAt: "2026-09-22T10:00:00.000Z",
      authorityReferences: [{
        kind: "standing_grant",
        referenceId: "trigger-policy-lease",
        evidenceSha256: policySha256,
      }],
      untrustedInfluences: [{
        kind: "model",
        referenceId:
          `workflow-plan-node:${modelInfluenceSha256.slice(0, 48)}`,
        contentSha256: modelInfluenceSha256,
      }],
    });
    const now = new Date();
    const lease = buildPolicyLeaseV1({
      executionId,
      toolId: tool!.id,
      inputSha256: toolInputSha256(input),
      targetSha256: approvalGrantTargetSha256(tool!, input),
      principal: { kind: "agent", id: principalId, generation: 7 },
      policySha256,
      influenceManifestSha256: influenceManifest.manifestSha256,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
    const policyLeaseClaim = {
      lease,
      influenceManifest,
      authority: {
        tenantId,
        ownerActorId: actorId,
        triggerId: "trigger-policy-lease",
        occurrenceId: "occurrence-policy-lease",
        workflowRunId: "workflow-run-lease",
        scheduleConfigurationSha256: "2".repeat(64),
        occurrenceAuthoritySha256: "3".repeat(64),
        reviewedSnapshotSha256: "4".repeat(64),
        mutationPolicySha256: policySha256,
        bindingIndex: 0,
        toolContractSha256: approvalGrantToolContractSha256(tool!),
        bindingSha256: "5".repeat(64),
      },
    } as const;
    const effectBinding = {
      workflowRunId: "workflow-run-lease",
      planId: "plan-1",
      planSha256: "6".repeat(64),
      planNodeId: "node-1",
    } as const;
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: principalId,
      correlationId: "occurrence-policy-lease",
      purpose: "workflow.node.tool.execute",
    });
    audit.claimIdempotentToolExecution.mockRejectedValueOnce(
      new PolicyLeaseStoreError(
        "binding_mismatch",
        "The live schedule identity changed.",
      ),
    );
    const fetchMock = vi.fn(() => {
      throw new Error("The provider effect must not run after lease failure.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const result = await executor.executeGovernedTool({
      toolId: tool!.id,
      input,
      dryRun: false,
      approved: true,
      context: {
        tenantId,
        actorId,
        role: "admin",
        source: "default",
      },
      idempotencyKey,
      executionScope,
      effectBinding,
      policyLeaseClaim,
    });

    expect(result.record.status).toBe("approval_required");
    expect(store.openToolExecutionInput(result.record)).toMatchObject({
      connectionId,
    });
    expect(result.result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit.claimIdempotentToolExecution).toHaveBeenCalledTimes(1);
    expect(
      store.getToolExecutionWorkflowEffectBindingSha256(result.record),
    ).toBe(canonicalJsonSha256(effectBinding));
    expect(store.publicToolExecution(result.record).output).not.toHaveProperty(
      "__workflowEffectBindingSha256",
    );
  });
});
