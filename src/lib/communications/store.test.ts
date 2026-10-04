import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ExecutionScope } from "@/lib/security/execution-scope";

const database = vi.hoisted(() => ({
  priorDraft: undefined as unknown,
  priorReceipt: undefined as unknown,
  deliveryRead: false,
  queries: [] as string[],
  bindings: [] as unknown[][],
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  hasDatabaseUrl: () => true,
  getSql: () => ({
    transaction: async (work: (sql: unknown) => Promise<unknown>) => work(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");
        database.queries.push(query);
        database.bindings.push(values);
        if (query.includes("SELECT draft FROM omni_message_drafts")) {
          return database.priorDraft ? [{ draft: database.priorDraft }] : [];
        }
        if (database.deliveryRead && query.includes("SELECT receipt FROM omni_delivery_receipts")) {
          return database.priorReceipt ? [{ receipt: database.priorReceipt }] : [];
        }
        throw new Error("Only the saved draft and exact accepted receipt may be read on a retry.");
      },
    ),
  }),
}));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: vi.fn() }));

import {
  GOVERNED_COMMUNICATION_VERSION,
  deliveryReceiptSchema,
  messageDraftSchema,
  type MessageDraft,
} from "@/lib/communications/contracts";
import { beginMessageDelivery, createMessageDraft } from "@/lib/communications/store";

const personalConnectionId = "8d9a7f0e-6f4b-4c1e-9a52-1f0c2b3d4e5f";
const workConnectionId = "2b6c1d0a-3e4f-4a5b-8c7d-9e0f1a2b3c4d";

const owner = {
  tenantId: "tenant-a",
  actorId: "user-a",
  executionScope: {
    tenantId: "tenant-a",
    initiatingActorId: "user-a",
  } as unknown as ExecutionScope,
};

function savedDraft(googleConnectionId?: string) {
  const immutable = {
    version: GOVERNED_COMMUNICATION_VERSION,
    id: "message_draft:123e4567-e89b-12d3-a456-426614174000",
    intentId: "communication_intent:123e4567-e89b-12d3-a456-426614174001",
    policyId: "contact_policy:123e4567-e89b-12d3-a456-426614174002",
    channel: "email" as const,
    recipient: "customer@example.com",
    subject: "Status",
    body: "The exact reviewed message.",
    senderIdentity: "connected_account" as const,
    ...(googleConnectionId ? { googleConnectionId } : {}),
    createdAt: "2026-09-07T01:00:00.000Z",
  };
  return messageDraftSchema.parse({
    ...immutable,
    state: "ready",
    lifecycleRevision: 1,
    updatedAt: immutable.createdAt,
    draftSha256: canonicalJsonSha256(immutable),
  });
}

function retry(googleConnectionId: string) {
  return createMessageDraft({
    policyId: "contact_policy:123e4567-e89b-12d3-a456-426614174002",
    purpose: "informational",
    disclosure: "public_only",
    subject: "Status",
    body: "The exact reviewed message.",
    executingAgentId: "agent:user-a",
    idempotencyKey: "draft-request-1",
    googleConnectionId,
  }, owner);
}

beforeEach(() => {
  database.priorDraft = undefined;
  database.priorReceipt = undefined;
  database.deliveryRead = false;
  database.queries = [];
  database.bindings = [];
});

describe("retried Gmail draft requests", () => {
  it("returns a draft saved before drafts named their Google account", async () => {
    const legacy = savedDraft();
    database.priorDraft = legacy;

    await expect(retry(personalConnectionId)).resolves.toEqual(legacy);
    expect(database.queries).toHaveLength(1);
  });

  it("returns a draft to a retry from the account that saved it", async () => {
    const saved = savedDraft(personalConnectionId);
    database.priorDraft = saved;

    await expect(retry(personalConnectionId)).resolves.toEqual(saved);
  });

  it("refuses a retry from another Google account", async () => {
    database.priorDraft = savedDraft(personalConnectionId);

    await expect(retry(workConnectionId)).rejects.toMatchObject({
      code: "delivery_conflict",
      message: "The idempotency key is already bound to another Google account.",
    });
  });
});

function acceptedDelivery() {
  const draft = { ...savedDraft(personalConnectionId), state: "delivered" as const };
  const body = {
    version: GOVERNED_COMMUNICATION_VERSION,
    id: "delivery_receipt:123e4567-e89b-12d3-a456-426614174003",
    draftId: draft.id,
    draftSha256: draft.draftSha256,
    provider: "gmail" as const,
    googleConnectionId: personalConnectionId,
    providerMessageId: "gmail-message-accepted",
    externalThreadId: "gmail-thread-accepted",
    providerAcknowledgementSha256: "a".repeat(64),
    observedTargetStateSha256: "b".repeat(64),
    outcome: "delivered_verified" as const,
    deliveredAt: "2026-09-07T01:01:00.000Z",
  };
  const receipt = deliveryReceiptSchema.parse({ ...body, receiptSha256: canonicalJsonSha256(body) });
  database.deliveryRead = true;
  database.priorDraft = draft;
  database.priorReceipt = receipt;
  return { draft, receipt };
}

function exactReview(draft: MessageDraft) {
  return {
    draftId: draft.id,
    expectedDraftSha256: draft.draftSha256,
    reviewedRecipient: draft.recipient,
    reviewedSubject: draft.subject,
    reviewedBody: draft.body,
  };
}

describe("accepted Gmail delivery recovery", () => {
  it("returns only the exact owner-scoped receipt without reacquiring mutable contact authority", async () => {
    const { draft, receipt } = acceptedDelivery();

    await expect(beginMessageDelivery(exactReview(draft), owner)).resolves.toEqual({
      state: "delivered", receipt,
    });

    expect(database.queries).toHaveLength(2);
    expect(database.bindings).toEqual([
      [owner.tenantId, owner.actorId, draft.id],
      [owner.tenantId, owner.actorId, draft.id],
    ]);
  });

  it("rejects a changed visible review even when delivery was already accepted", async () => {
    const { draft } = acceptedDelivery();
    for (const changed of [
      { draftId: "message_draft:123e4567-e89b-12d3-a456-426614174099" },
      { expectedDraftSha256: "f".repeat(64) },
      { reviewedRecipient: "another@example.com" },
      { reviewedSubject: "Another subject" },
      { reviewedBody: "Another message" },
    ]) {
      await expect(beginMessageDelivery({ ...exactReview(draft), ...changed }, owner))
        .rejects.toMatchObject({ code: "draft_changed" });
    }
  });

  it("rejects a well-formed receipt for another draft, digest or pinned account", async () => {
    const { draft, receipt } = acceptedDelivery();
    const { receiptSha256: _hash, ...body } = receipt;
    void _hash;
    for (const changed of [
      { draftId: "message_draft:123e4567-e89b-12d3-a456-426614174099" },
      { draftSha256: "f".repeat(64) },
      { googleConnectionId: workConnectionId },
      { googleConnectionId: undefined },
    ]) {
      const next = { ...body, ...changed };
      database.priorReceipt = deliveryReceiptSchema.parse({ ...next, receiptSha256: canonicalJsonSha256(next) });
      await expect(beginMessageDelivery(exactReview(draft), owner))
        .rejects.toMatchObject({ code: "delivery_conflict" });
    }
  });
});
