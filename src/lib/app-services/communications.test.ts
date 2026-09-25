import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  create: vi.fn(),
  fail: vi.fn(),
  get: vi.fn(),
  listDrafts: vi.fn(),
  listPolicies: vi.fn(),
  upsert: vi.fn(),
  deliver: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock("@/lib/communications/store", () => ({
  beginMessageDelivery: mocks.begin,
  completeMessageDelivery: mocks.complete,
  createMessageDraft: mocks.create,
  failMessageDelivery: mocks.fail,
  getMessageDraft: mocks.get,
  listMessageDrafts: mocks.listDrafts,
  listPersonContactPolicies: mocks.listPolicies,
  upsertPersonContactPolicy: mocks.upsert,
}));
vi.mock("@/lib/communications/gmail-delivery", () => {
  class Unknown extends Error {}
  return {
    deliverGmailDraft: mocks.deliver,
    GmailDeliveryOutcomeUnknownError: Unknown,
  };
});
vi.mock("@/lib/threads/store", () => ({ getOwnedThread: mocks.getThread }));
vi.mock("@/lib/connectors/google-workspace-access", () => ({
  getActiveGoogleWorkspaceAccess: mocks.access,
}));

import {
  createCommunicationDraftService,
  deliverCommunicationDraftService,
} from "@/lib/app-services/communications";
import { GmailDeliveryOutcomeUnknownError } from "@/lib/communications/gmail-delivery";

const googleConnectionId = "5b1d7e3a-9c2f-4a6b-8d0e-1f3a5c7e9b2d";

describe("governed communication application service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThread.mockResolvedValue({ id: "thread-a" });
    mocks.get.mockResolvedValue({ id: "message_draft:123e4567-e89b-12d3-a456-426614174000", state: "delivered" });
  });

  it("binds draft attribution to the authenticated execution scope", async () => {
    mocks.access.mockResolvedValue({
      accessToken: "gmail-access-token",
      grant: {
        id: googleConnectionId,
        tenantId: "tenant-a",
        actorId: "actor-a",
        provider: "google",
        accountEmail: "owner@example.com",
        connectionLabel: "Personal",
        connectionPurpose: "personal",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        status: "active",
        authorizationGeneration: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    });
    mocks.create.mockResolvedValue({ id: "message_draft:123e4567-e89b-12d3-a456-426614174000" });
    const result = await createCommunicationDraftService(caller(), {
      connectionId: googleConnectionId,
      policyId: "contact_policy:123e4567-e89b-12d3-a456-426614174001",
      purpose: "support",
      disclosure: "relationship_context",
      subject: "Status",
      body: "Exact draft body",
      canonicalThreadId: "thread-a",
    });
    expect(mocks.access).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
      connectionId: googleConnectionId,
      capability: "gmail.send",
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        googleConnectionId,
        executingAgentId: "agent-main",
        projectId: "project-a",
        missionId: "mission-a",
        runId: "run-a",
        idempotencyKey: "communication-test",
      }),
      expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "actor-a",
        executionScope: expect.objectContaining({ initiatingActorId: "actor-a" }),
      }),
    );
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain("gmail-access-token");
    expect(result.receipt.operation).toBe("app.communications.drafts.create");
  });

  it("delivers the claimed stored draft and persists provider verification", async () => {
    const draft = { id: "message_draft:123e4567-e89b-12d3-a456-426614174000", state: "delivering" };
    mocks.begin.mockResolvedValue({ state: "deliver", draft });
    mocks.deliver.mockResolvedValue({
      providerMessageId: "gmail-message-1",
      externalThreadId: "gmail-thread-1",
      providerAcknowledgement: "provider_response",
      providerAcknowledgementSha256: "1".repeat(64),
      observedTargetStateSha256: "2".repeat(64),
    });
    mocks.complete.mockResolvedValue({ id: "delivery-receipt-1" });

    const result = await deliverCommunicationDraftService(caller(), deliveryInput());

    expect(mocks.deliver).toHaveBeenCalledWith(draft, expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "actor-a",
      mode: "deliver",
    }));
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        draft,
        providerMessageId: "gmail-message-1",
        externalThreadId: "gmail-thread-1",
      }),
      expect.any(Object),
    );
    expect(result.data.deliveryReceipt).toEqual({ id: "delivery-receipt-1" });
  });

  it("leaves an unknown provider outcome reconcilable instead of marking it failed", async () => {
    mocks.begin.mockResolvedValue({ state: "reconcile", draft: { id: deliveryInput().draftId } });
    mocks.deliver.mockRejectedValue(new GmailDeliveryOutcomeUnknownError("not visible"));
    await expect(deliverCommunicationDraftService(caller(), deliveryInput())).rejects.toThrow("not visible");
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("keeps a verified send reconcile-only when local receipt persistence fails", async () => {
    const draft = {
      id: "message_draft:123e4567-e89b-12d3-a456-426614174000",
      state: "delivering",
    };
    mocks.begin
      .mockResolvedValueOnce({ state: "deliver", draft })
      .mockResolvedValueOnce({ state: "reconcile", draft });
    mocks.deliver
      .mockResolvedValueOnce({
        providerMessageId: "gmail-message-1",
        externalThreadId: "gmail-thread-1",
        providerAcknowledgement: "provider_response",
        providerAcknowledgementSha256: "1".repeat(64),
        observedTargetStateSha256: "2".repeat(64),
      })
      .mockRejectedValueOnce(new GmailDeliveryOutcomeUnknownError("not visible yet"));
    mocks.complete.mockRejectedValueOnce(new Error("receipt database unavailable"));

    await expect(deliverCommunicationDraftService(caller(), deliveryInput()))
      .rejects.toThrow("receipt database unavailable");
    await expect(deliverCommunicationDraftService(caller(), deliveryInput()))
      .rejects.toThrow("not visible yet");

    expect(mocks.deliver.mock.calls.map(([, options]) => options.mode))
      .toEqual(["deliver", "reconcile"]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });
});

function caller() {
  return createAppServiceCaller({
    context: {
      tenantId: "tenant-a",
      actorId: "actor-a",
      role: "operator",
      source: "service",
    },
    executionScope: createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "agent",
      executingPrincipalId: "agent-main",
      workspaceId: "workspace-a",
      projectId: "project-a",
      missionId: "mission-a",
      correlationId: "run-a",
      purpose: "communication-test",
    }),
    idempotencyKey: "communication-test",
  });
}

function deliveryInput() {
  return {
    draftId: "message_draft:123e4567-e89b-12d3-a456-426614174000",
    expectedDraftSha256: "a".repeat(64),
    reviewedRecipient: "customer@example.com",
    reviewedSubject: "Status",
    reviewedBody: "Exact draft body",
  };
}
