import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { googleWorkspaceEffectTarget } from "@/lib/connectors/google-workspace-actions";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const WORKSPACE_CONNECTION_ID = "5f0c6a8e-2b1d-4c3e-9f7a-1d2e3f4a5b6c";
const OTHER_CONNECTION_ID = "8d4e2c1b-6a5f-4e3d-8c2b-1a0f9e8d7c6b";

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
      grant: {
        id: WORKSPACE_CONNECTION_ID,
        accountEmail: "owner-workspace@example.test",
        connectionLabel: "Personal",
        connectionPurpose: "personal",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("approval-gates a Drive mutation and records a verified provider receipt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(driveFile("old-name.txt")))
      .mockResolvedValueOnce(json(driveFile("new-name.txt")))
      .mockResolvedValueOnce(json(driveFile("new-name.txt")));
    vi.stubGlobal("fetch", fetchMock);
    const harness = await executorHarness("drive-rename");
    const input = {
      connectionId: WORKSPACE_CONNECTION_ID,
      fileId: "file_1",
      name: "new-name.txt",
    };

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
      connectionId: WORKSPACE_CONNECTION_ID,
      capability: "drive.write",
    });
    expect(executed.result).toMatchObject({
      toolId: "google.drive.rename",
      connectionId: WORKSPACE_CONNECTION_ID,
      connectionLabel: "Personal",
      connectionPurpose: "personal",
    });
    const boundTarget = googleWorkspaceEffectTarget(
      "google.drive.rename",
      input,
      executed.record.id,
    );
    expect(boundTarget.targetId).not.toBe(googleWorkspaceEffectTarget(
      "google.drive.rename",
      { ...input, connectionId: OTHER_CONNECTION_ID },
      executed.record.id,
    ).targetId);
    expect(executed.record.effectReceipt?.targetId).toBe(boundTarget.targetId);
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

  it("approval-gates native Docs creation and records its verified creation effect", async () => {
    const harness = await executorHarness("docs-create");
    const input = {
      connectionId: WORKSPACE_CONNECTION_ID,
      title: "Governed research note",
      bodyText: "Only one provider-native document is created.",
    };
    let executionId = "";
    let documentReadCount = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({ files: [] });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        return json({ id: "document_effect_1" });
      }
      if (url.includes("documents/document_effect_1:batchUpdate")) return json({});
      if (url.includes("/drive/v3/files/document_effect_1")) {
        return json({
          id: "document_effect_1",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: docsCreateProperties(input, executionId),
        });
      }
      if (new URL(url).pathname.endsWith("/documents/document_effect_1")) {
        documentReadCount += 1;
        return documentReadCount === 1
          ? json({
              documentId: "document_effect_1",
              title: input.title,
              revisionId: "revision-pristine",
              body: { content: [] },
            })
          : json({
              documentId: "document_effect_1",
              title: input.title,
              revisionId: "revision-created",
              body: {
                content: [{
                  startIndex: 1,
                  endIndex: input.bodyText.length + 2,
                  paragraph: {
                    elements: [{ textRun: { content: `${input.bodyText}\n` } }],
                  },
                }],
              },
            });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = await harness.executor.executeGovernedTool({
      toolId: "google.docs.create",
      input,
      dryRun: false,
      context: harness.context,
      executionScope: harness.scope,
    });
    expect(pending.record.status).toBe("approval_required");
    executionId = pending.record.id;
    const claimToken = "docs-create-claim";
    const claim = await harness.store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: harness.tenantId,
      approvedBy: "workspace-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await harness.executor.executeGovernedTool({
      toolId: "google.docs.create",
      input: harness.store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: harness.context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(access.getActive).toHaveBeenCalledWith({
      tenantId: harness.tenantId,
      actorId: harness.actorId,
      connectionId: WORKSPACE_CONNECTION_ID,
      capability: "docs.write",
    });
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("/drive/v3/files?") && init?.method === "POST"))
      .toHaveLength(1);
    expect(executed.result).toMatchObject({
      toolId: "google.docs.create",
      resourceId: "document_effect_1",
      connectionId: WORKSPACE_CONNECTION_ID,
      connectionLabel: "Personal",
      connectionPurpose: "personal",
      editorUrl: "https://docs.google.com/document/d/document_effect_1/edit",
    });
    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: "google.docs.create",
        targetType: "google_workspace_resource",
        providerAcknowledgement: "provider_response",
        verificationState: "verified",
        verificationReasonCode: "state_matched",
      },
    });
  });

  it("reclaims a crashed stale Docs create and repairs its exact marker without duplication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-19T06:00:00.000Z"));
    const harness = await executorHarness("docs-create-repair");
    const input = {
      connectionId: WORKSPACE_CONNECTION_ID,
      title: "Governed research note",
      bodyText: "Resume this exact provider-native document.",
    };
    let executionId = "";
    let searchCount = 0;
    let createCount = 0;
    let batchCount = 0;
    let documentReadCount = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        searchCount += 1;
        return searchCount === 1
          ? json({ files: [] })
          : json({
              files: [{
                id: "document_partial_effect",
                name: input.title,
                mimeType: "application/vnd.google-apps.document",
                trashed: false,
                appProperties: docsCreateProperties(input, executionId),
              }],
            });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        createCount += 1;
        return json({ id: "document_partial_effect" });
      }
      if (url.includes("/drive/v3/files/document_partial_effect")) {
        return json({
          id: "document_partial_effect",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: docsCreateProperties(input, executionId),
        });
      }
      if (url.includes("documents/document_partial_effect:batchUpdate")) {
        batchCount += 1;
        return batchCount === 1
          ? Response.json({ error: { message: "response lost" } }, { status: 503 })
          : json({});
      }
      if (new URL(url).pathname.endsWith("/documents/document_partial_effect")) {
        documentReadCount += 1;
        return documentReadCount < 4
          ? json({
              documentId: "document_partial_effect",
              title: input.title,
              revisionId: "revision-partial",
              body: { content: [] },
            })
          : json({
              documentId: "document_partial_effect",
              title: input.title,
              revisionId: "revision-complete",
              body: {
                content: [{
                  startIndex: 1,
                  endIndex: input.bodyText.length + 2,
                  paragraph: {
                    elements: [{ textRun: { content: `${input.bodyText}\n` } }],
                  },
                }],
              },
            });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = await harness.executor.executeGovernedTool({
      toolId: "google.docs.create",
      input,
      dryRun: false,
      context: harness.context,
      executionScope: harness.scope,
    });
    executionId = pending.record.id;
    const claimToken = "docs-create-repair-claim";
    const claim = await harness.store.approveAndClaimToolExecution({
      id: executionId,
      tenantId: harness.tenantId,
      approvedBy: "workspace-reviewer",
      approvedRole: "admin",
      claimToken,
    });

    await expect(harness.executor.executeGovernedTool({
      toolId: "google.docs.create",
      input: harness.store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: harness.context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    })).rejects.toBeInstanceOf(harness.executor.EffectReceiptFinalizationError);

    const retained = await harness.store.getToolExecution(executionId, {
      tenantId: harness.tenantId,
    });
    expect(retained?.status).toBe("executing");
    expect(harness.store.getToolExecutionEffectIntentV2(retained!)).toMatchObject({
      toolId: "google.docs.create",
      targetType: "google_workspace_resource",
    });

    vi.setSystemTime(new Date("2026-09-19T06:06:00.000Z"));
    const retryClaimToken = "docs-create-repair-reclaimed";
    await expect(harness.store
      .reclaimStaleGoogleWorkspaceCreateToolExecutionClaim(retained!, {
        tenantId: harness.tenantId,
        claimToken: "wrong-actor-reclaim",
        executionScope: {
          ...harness.scope,
          initiatingActorId: "another-actor",
          executingPrincipalId: "another-actor",
        },
        idempotencyKey: "approval:docs-create-repair:wrong-actor",
      })).resolves.toBeUndefined();
    const reclaimed = await harness.store
      .reclaimStaleGoogleWorkspaceCreateToolExecutionClaim(retained!, {
        tenantId: harness.tenantId,
        claimToken: retryClaimToken,
        executionScope: harness.scope,
        idempotencyKey: "approval:docs-create-repair",
      });
    expect(reclaimed).toBeDefined();
    await expect(harness.store
      .reclaimStaleGoogleWorkspaceCreateToolExecutionClaim(retained!, {
        tenantId: harness.tenantId,
        claimToken: "competing-reclaim",
        executionScope: harness.scope,
        idempotencyKey: "approval:docs-create-repair:competing",
      })).resolves.toBeUndefined();

    const repaired = await harness.executor.executeGovernedTool({
      toolId: "google.docs.create",
      input: harness.store.openToolExecutionInput(reclaimed!),
      dryRun: false,
      approved: true,
      context: harness.context,
      existingRecord: reclaimed,
      executionClaimToken: retryClaimToken,
    });

    expect(createCount).toBe(1);
    expect(searchCount).toBe(3);
    expect(batchCount).toBe(2);
    const repairWrite = fetchMock.mock.calls.filter(([request]) =>
      String(request).includes("documents/document_partial_effect:batchUpdate"))[1];
    expect(JSON.parse(String(repairWrite?.[1]?.body)).writeControl).toEqual({
      requiredRevisionId: "revision-partial",
    });
    expect(repaired.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        toolId: "google.docs.create",
        providerAcknowledgement: "provider_response",
        verificationState: "verified",
      },
    });
    expect(repaired.result).toMatchObject({
      resourceId: "document_partial_effect",
      editorUrl:
        "https://docs.google.com/document/d/document_partial_effect/edit",
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
      input: { connectionId: WORKSPACE_CONNECTION_ID, messageId: "message_1" },
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
        connectionId: WORKSPACE_CONNECTION_ID,
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function docsCreateProperties(input: Record<string, unknown>, executionId: string) {
  return {
    asaelExecution: sha256(executionId),
    asaelIntent: canonicalJsonSha256({
      toolId: "google.docs.create",
      input,
    }),
    asaelScope: canonicalJsonSha256({
      tenantId: "tenant-workspace",
      actorId: "owner-workspace",
    }),
    asaelCreateVersion: "2",
  };
}
