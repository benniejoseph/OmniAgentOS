import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  GOVERNED_COMMUNICATION_VERSION,
  inboundCommunicationEnvelopeSchema,
  messageDraftSchema,
  personContactPolicySchema,
} from "@/lib/communications/contracts";

describe("governed communication contracts", () => {
  it("binds a contact policy to its owner, consent, disclosure, and delivery limits", () => {
    const body = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: "contact_policy:123e4567-e89b-12d3-a456-426614174000",
      tenantId: "tenant-a",
      ownerActorId: "user-a",
      personRef: "person:customer-a",
      displayName: "Customer A",
      channel: "email" as const,
      address: "customer@example.com",
      relationship: "customer" as const,
      allowedPurposes: ["support"] as const,
      allowedDisclosure: "relationship_context" as const,
      consent: "explicit" as const,
      approvalMode: "always" as const,
      senderIdentity: "connected_account" as const,
      maxDeliveriesPerDay: 2,
      quietHours: {
        enabled: true,
        timeZone: "Asia/Kolkata",
        start: "22:00",
        end: "07:00",
      },
      status: "active" as const,
      optOutReason: null,
      lifecycleRevision: 1,
      createdAt: "2026-09-07T01:00:00.000Z",
      updatedAt: "2026-09-07T01:00:00.000Z",
    };
    const parsed = personContactPolicySchema.parse({
      ...body,
      policySha256: canonicalJsonSha256(body),
    });
    expect(parsed.approvalMode).toBe("always");
    expect(parsed.senderIdentity).toBe("connected_account");
  });

  it("rejects a mutated message after its immutable draft was reviewed", () => {
    const body = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: "message_draft:123e4567-e89b-12d3-a456-426614174000",
      intentId: "communication_intent:123e4567-e89b-12d3-a456-426614174001",
      policyId: "contact_policy:123e4567-e89b-12d3-a456-426614174002",
      channel: "email" as const,
      recipient: "customer@example.com",
      subject: "Update",
      body: "The exact reviewed message.",
      senderIdentity: "connected_account" as const,
      state: "ready" as const,
      lifecycleRevision: 1,
      createdAt: "2026-09-07T01:00:00.000Z",
      updatedAt: "2026-09-07T01:00:00.000Z",
    };
    const draftSha256 = canonicalJsonSha256({
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
    });
    expect(messageDraftSchema.parse({ ...body, draftSha256 })).toBeTruthy();
    expect(() => messageDraftSchema.parse({
      ...body,
      body: "A different message.",
      draftSha256,
    })).toThrow(/draftSha256/i);
  });

  it("marks mapped inbound content as untrusted and self-verifying", () => {
    const body = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: "inbound_communication:123e4567-e89b-12d3-a456-426614174000",
      provider: "gmail" as const,
      providerMessageId: "gmail-message-1",
      externalThreadId: "gmail-thread-1",
      linkId: "conversation_link:123e4567-e89b-12d3-a456-426614174001",
      fromAddressSha256: "1".repeat(64),
      toAddressSha256: "2".repeat(64),
      subjectSha256: "3".repeat(64),
      contentSha256: "4".repeat(64),
      receivedAt: "2026-09-07T01:00:00.000Z",
      untrusted: true as const,
    };
    expect(inboundCommunicationEnvelopeSchema.parse({
      ...body,
      envelopeSha256: canonicalJsonSha256(body),
    }).untrusted).toBe(true);
  });
});
