import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const access = vi.hoisted(() => ({
  getActive: vi.fn(),
}));

vi.mock("@/lib/connectors/google-workspace-access", () => ({
  getActiveGoogleWorkspaceAccess: access.getActive,
}));

describe("Google Workspace executor effect receipts", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-google-workspace-effect-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    access.getActive.mockResolvedValue({
      accessToken: "workspace-access-token",
      grant: { id: "grant-workspace" },
    });
  });

  it("approval-gates a Drive mutation and records a verified provider receipt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(driveFile("old-name.txt")))
      .mockResolvedValueOnce(json(driveFile("new-name.txt")))
      .mockResolvedValueOnce(json(driveFile("new-name.txt")));
    vi.stubGlobal("fetch", fetchMock);
    const harness = await executorHarness("drive-rename");
    const input = { fileId: "file_1", name: "new-name.txt" };

    const pending = await harness.executor.executeGovernedTool({
      toolId: "google.drive.rename",
      input,
      dryRun: false,
      context: harness.context,
      executionScope: harness.scope,
    });
    expect(pending.record.status).toBe("approval_required");
    const claimToken = "drive-rename-claim";
    const claim = await harness.store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: harness.tenantId,
      approvedBy: "workspace-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await harness.executor.executeGovernedTool({
      toolId: "google.drive.rename",
      input: harness.store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: harness.context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);
    expect(access.getActive).toHaveBeenCalledWith({
      tenantId: harness.tenantId,
      actorId: harness.actorId,
      capability: "drive.write",
    });
    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: "google.drive.rename",
        targetType: "google_workspace_resource",
        providerAcknowledgement: "provider_response",
        verificationState: "verified",
        verificationReasonCode: "state_matched",
      },
    });
  });

  it("reconciles a lost Gmail Trash acknowledgement without deleting twice", async () => {
    let getCount = 0;
    let postCount = 0;
    const fetchMock = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        return json({ id: "message_1", labelIds: ["TRASH"] });
      }
      getCount += 1;
      if (getCount === 1) return json({ id: "message_1", labelIds: ["INBOX"] });
      if (getCount === 2) throw new Error("verification response lost");
      return json({ id: "message_1", labelIds: ["TRASH"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await executorHarness("gmail-trash");
    const idempotencyKey = "google-workspace:gmail-trash-once";
    const request = {
      toolId: "google.gmail.trash",
      input: { messageId: "message_1" },
      dryRun: false,
      approved: true,
      context: harness.context,
      executionScope: harness.scope,
      idempotencyKey,
    } as const;

    await expect(harness.executor.executeGovernedTool(request))
      .rejects.toBeInstanceOf(harness.executor.EffectReceiptFinalizationError);
    const executionId = `idem_${createHash("sha256")
      .update(`${harness.tenantId}\0${idempotencyKey}`)
      .digest("hex")}`;
    const retained = await harness.store.getToolExecution(executionId, {
      tenantId: harness.tenantId,
    });
    expect(retained?.status).toBe("executing");
    expect(harness.store.getToolExecutionEffectIntentV2(retained!)).toMatchObject({
      toolId: "google.gmail.trash",
      targetType: "google_workspace_resource",
    });

    const reconciled = await harness.executor.executeGovernedTool(request);
    expect(postCount).toBe(1);
    expect(getCount).toBe(3);
    expect(reconciled.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        providerAcknowledgement: "provider_idempotency_reconciliation",
        verificationState: "verified",
      },
    });
  });

  it("does not duplicate a Drive create while its provider result is inconclusive", async () => {
    let searchCount = 0;
    let createCount = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "POST" && url.includes("upload/drive/v3/files")) {
        createCount += 1;
        return json({ id: "file_1" });
      }
      if (url.includes("/drive/v3/files?") && (!init?.method || init.method === "GET")) {
        searchCount += 1;
        return json({ files: [] });
      }
      if (url.includes("/drive/v3/files/file_1")) {
        throw new Error("post-create verification response lost");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await executorHarness("drive-create");
    const request = {
      toolId: "google.drive.create",
      input: {
        name: "private.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("private", "utf8").toString("base64"),
      },
      dryRun: false,
      approved: true,
      context: harness.context,
      executionScope: harness.scope,
      idempotencyKey: "google-workspace:drive-create-once",
    } as const;

    await expect(harness.executor.executeGovernedTool(request))
      .rejects.toBeInstanceOf(harness.executor.EffectReceiptFinalizationError);
    const retried = await harness.executor.executeGovernedTool(request);

    expect(createCount).toBe(1);
    expect(searchCount).toBe(2);
    expect(retried.record.status).toBe("executing");
    expect(retried.result).toBeNull();
  });
});

async function executorHarness(correlationId: string) {
  const tenantId = "tenant-workspace";
  const actorId = "owner-workspace";
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
    correlationId,
    purpose: `tool.${correlationId}`,
  });
  const executor = await import("@/lib/tools/executor");
  const store = await import("@/lib/tools/audit-store");
  return { tenantId, actorId, context, scope, executor, store };
}

function driveFile(name: string) {
  return {
    id: "file_1",
    name,
    mimeType: "text/plain",
    parents: ["folder_1"],
    trashed: false,
  };
}

function json(value: unknown) {
  return Response.json(value, { status: 200 });
}
