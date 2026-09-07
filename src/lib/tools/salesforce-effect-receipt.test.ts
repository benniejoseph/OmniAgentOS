import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeApp: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@/lib/app-services/tool-dispatcher", () => ({
  executeFirstPartyAppTool: mocks.executeApp,
}));
vi.mock("@/lib/app-services/salesforce-writes", () => ({
  reconcileSalesforceRecordWriteService: mocks.reconcile,
}));

import {
  salesforceWriteExpectedTargetStateSha256,
  salesforceWriteOperationId,
} from "@/lib/customer-success/salesforce-write-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const tenantId = "tenant-salesforce-effect";
const actorId = "actor:salesforce-owner";
const accountId = `customer-account:${"a".repeat(64)}`;
const toolId = "app.customer_accounts.salesforce.contact.create" as const;
const toolInput = {
  accountId,
  expectedAccountRevision: 4,
  fields: { LastName: "Lovelace" },
};
const context = {
  tenantId,
  actorId,
  role: "admin" as const,
  source: "default" as const,
};
const scope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  workspaceId: "workspace:personal:salesforce-owner",
  correlationId: "salesforce-effect-test",
  purpose: "tool.salesforce.write",
});

function commit(
  executionId: string,
  valid = true,
  providerAcknowledgement:
    | "provider_response"
    | "provider_idempotency_reconciliation" = "provider_response",
) {
  const expectedTargetStateSha256 = salesforceWriteExpectedTargetStateSha256({
    toolId,
    value: toolInput,
    executionId,
  });
  return {
    schemaVersion: 1,
    contractVersion: "p10.11-salesforce-guarded-write:1",
    operationId: salesforceWriteOperationId(executionId),
    toolId,
    objectType: "Contact",
    action: "create",
    providerRecordIdSha256: "b".repeat(64),
    providerModifiedAt: "2026-09-08T03:00:00.000Z",
    providerAcknowledgement,
    providerAcknowledgementId: `salesforce_ack_${"c".repeat(48)}`,
    providerAcknowledgementSha256: "d".repeat(64),
    expectedTargetStateSha256: valid
      ? expectedTargetStateSha256
      : "e".repeat(64),
    observedTargetStateSha256: valid
      ? expectedTargetStateSha256
      : "e".repeat(64),
    verificationState: "verified",
    verificationReasonCode: "state_matched",
  } as const;
}

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-salesforce-effect-"),
  );
  delete process.env.DATABASE_URL;
  mocks.executeApp.mockReset();
  mocks.reconcile.mockReset();
});

describe("governed Salesforce effect receipts", () => {
  it("requires approval and records a verified read-after-write receipt", async () => {
    mocks.executeApp.mockImplementation(async (input) => ({
      handled: true,
      result: { commit: commit(input.idempotencyKey) },
    }));
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executor.executeGovernedTool({
      toolId,
      input: toolInput,
      dryRun: false,
      context,
      executionScope: scope,
    });
    expect(pending.record.status).toBe("approval_required");
    const claimToken = "salesforce-write-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "salesforce-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    const result = await executor.executeGovernedTool({
      toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
    expect(result.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId,
        targetType: "salesforce_record",
        providerAcknowledgement: "provider_response",
        verificationState: "verified",
        verificationReasonCode: "state_matched",
      },
    });
  });

  it("reconciles a committed provider write without dispatching it twice", async () => {
    mocks.executeApp.mockImplementationOnce(async (input) => ({
      handled: true,
      result: { commit: commit(input.idempotencyKey, false) },
    }));
    mocks.reconcile.mockImplementation(async (caller) => ({
      data: {
        commit: commit(
          caller.idempotencyKey,
          true,
          "provider_idempotency_reconciliation",
        ),
      },
      receipt: { receiptKind: "app_service_receipt" },
    }));
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const idempotencyKey = "salesforce-contact-create-once";
    const request = {
      toolId,
      input: toolInput,
      dryRun: false,
      approved: true,
      context,
      executionScope: scope,
      idempotencyKey,
    } as const;

    await expect(executor.executeGovernedTool(request))
      .rejects.toBeInstanceOf(executor.EffectReceiptFinalizationError);
    const executionId = `idem_${(await import("node:crypto")).createHash("sha256")
      .update(`${tenantId}\0${idempotencyKey}`).digest("hex")}`;
    const retained = await store.getToolExecution(executionId, { tenantId });
    expect(retained?.status).toBe("executing");
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);

    const reconciled = await executor.executeGovernedTool(request);
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(reconciled.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        targetType: "salesforce_record",
        providerAcknowledgement: "provider_idempotency_reconciliation",
        verificationState: "verified",
      },
    });
  });
});
