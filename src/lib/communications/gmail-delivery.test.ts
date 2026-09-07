import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const oauth = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/connectors/oauth-store", () => ({
  getOAuthGrantSecrets: oauth.get,
  saveOAuthGrant: oauth.save,
}));

import {
  buildGmailRawMessage,
  deliverGmailDraft,
  GmailDeliveryOutcomeUnknownError,
  gmailRfcMessageId,
} from "@/lib/communications/gmail-delivery";
import {
  GOVERNED_COMMUNICATION_VERSION,
  messageDraftSchema,
} from "@/lib/communications/contracts";
import { GOOGLE_GMAIL_SEND_SCOPE } from "@/lib/connectors/oauth-providers";

describe("governed Gmail delivery", () => {
  beforeEach(() => {
    oauth.get.mockResolvedValue({
      grant: {
        scopes: [GOOGLE_GMAIL_SEND_SCOPE],
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      tokens: { access_token: "test-access-token" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    oauth.get.mockReset();
    oauth.save.mockReset();
  });

  it("sends and verifies only the exact immutable draft", async () => {
    const draft = sampleDraft();
    const raw = Buffer.from(buildGmailRawMessage(draft), "utf8").toString("base64url");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "gmail-message-1", threadId: "gmail-thread-1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "gmail-message-1", threadId: "gmail-thread-1", raw }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverGmailDraft(draft, {
      tenantId: "tenant-a",
      actorId: "user-a",
      mode: "deliver",
    });

    expect(result).toEqual(expect.objectContaining({
      providerMessageId: "gmail-message-1",
      externalThreadId: "gmail-thread-1",
      providerAcknowledgement: "provider_response",
    }));
    const sendBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { raw: string };
    expect(Buffer.from(sendBody.raw, "base64url").toString("utf8")).toContain(
      `Message-ID: ${gmailRfcMessageId(draft.draftSha256)}`,
    );
  });

  it("reconciles a prior provider message without sending again", async () => {
    const draft = sampleDraft();
    const raw = Buffer.from(buildGmailRawMessage(draft), "utf8").toString("base64url");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "gmail-message-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "gmail-message-1", threadId: "gmail-thread-1", raw }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverGmailDraft(draft, {
      tenantId: "tenant-a",
      actorId: "user-a",
      mode: "reconcile",
    });

    expect(result.providerAcknowledgement).toBe("provider_idempotency_reconciliation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("does not duplicate a prior attempt that is not yet visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ messages: [] })));
    await expect(deliverGmailDraft(sampleDraft(), {
      tenantId: "tenant-a",
      actorId: "user-a",
      mode: "reconcile",
    })).rejects.toBeInstanceOf(GmailDeliveryOutcomeUnknownError);
  });
});

function sampleDraft() {
  const body = {
    version: GOVERNED_COMMUNICATION_VERSION,
    id: "message_draft:123e4567-e89b-12d3-a456-426614174000",
    intentId: "communication_intent:123e4567-e89b-12d3-a456-426614174001",
    policyId: "contact_policy:123e4567-e89b-12d3-a456-426614174002",
    channel: "email" as const,
    recipient: "customer@example.com",
    subject: "Status ✓",
    body: "The exact reviewed message.\nSecond line.",
    senderIdentity: "connected_account" as const,
    state: "delivering" as const,
    lifecycleRevision: 2,
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:01:00.000Z",
  };
  const immutable = {
    version: body.version,
    id: body.id,
    intentId: body.intentId,
    policyId: body.policyId,
    channel: body.channel,
    recipient: body.recipient,
    subject: body.subject,
    body: body.body,
    senderIdentity: body.senderIdentity,
    createdAt: body.createdAt,
  };
  return messageDraftSchema.parse({
    ...body,
    draftSha256: canonicalJsonSha256(immutable),
  });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
