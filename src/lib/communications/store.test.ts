import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ExecutionScope } from "@/lib/security/execution-scope";

const database = vi.hoisted(() => ({
  priorDraft: undefined as unknown,
  queries: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  hasDatabaseUrl: () => true,
  getSql: () => ({
    transaction: async (work: (sql: unknown) => Promise<unknown>) => work(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        database.queries.push(query);
        if (!query.includes("SELECT draft FROM omni_message_drafts")) {
          throw new Error("Only the saved draft is read on a retry.");
        }
        return database.priorDraft ? [{ draft: database.priorDraft }] : [];
      },
    ),
  }),
}));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: vi.fn() }));

import {
  GOVERNED_COMMUNICATION_VERSION,
  messageDraftSchema,
} from "@/lib/communications/contracts";
import { createMessageDraft } from "@/lib/communications/store";

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

describe("retried Gmail draft requests", () => {
  beforeEach(() => {
    database.priorDraft = undefined;
    database.queries = [];
  });

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
