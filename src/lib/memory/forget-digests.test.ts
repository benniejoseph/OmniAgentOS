import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendDomainEvent,
  forgetEventDigests,
  type DomainEvent,
} from "@/lib/events/store";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { readJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

const TENANT_ID = "tenant-forget-digests";
const OTHER_TENANT_ID = "tenant-forget-digests-other";
const LEGACY_DIGEST = "a".repeat(64);

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-forget-digests-"),
  );
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function scope() {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId: "actor:owner",
    executingPrincipalType: "user",
    executingPrincipalId: "actor:owner",
    correlationId: "forget-digests-request",
    purpose: "test.memory.forget",
  });
}

async function events() {
  const ledger = await readJsonFile<{ events: DomainEvent[] }>(
    getDataPath("events.json"),
    { events: [] },
  );
  return ledger.events;
}

async function payloadOf(eventId: string) {
  return (await events()).find((event) => event.id === eventId)?.payload;
}

async function payloadOfType(type: string, field: string, id: string) {
  return (await events()).find((event) =>
    event.type === type && event.payload?.[field] === id
  )?.payload;
}

function legacyEvent(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  tenantId = TENANT_ID,
) {
  return appendDomainEvent({
    id,
    streamId: `memory:${id}`,
    type,
    tenantId,
    payload,
  });
}

describe("forgetting a memory's event digests (file mode)", () => {
  it("deletes the digests its events keep and leaves other memories' alone", async () => {
    const store = await import("@/lib/memory/store");
    const saved = await store.saveMemory({
      tenantId: TENANT_ID,
      title: "Private preference",
      content: "Never retain this sentence.",
      source: "manual",
      executionScope: scope(),
    });
    const descendant = await store.saveMemory({
      tenantId: TENANT_ID,
      title: "Derived preference",
      content: "Derived from the private sentence.",
      source: "manual",
      supersedesId: saved.id,
      evidenceRefs: [`memory:${saved.id}`],
      executionScope: scope(),
    });
    const kept = await store.saveMemory({
      tenantId: TENANT_ID,
      title: "Kept preference",
      content: "Keep this sentence.",
      source: "manual",
      executionScope: scope(),
    });
    const createdId = `memory_mutation_created_${saved.id}`;
    expect(await payloadOf(createdId)).toMatchObject({
      schemaVersion: 2,
      memoryId: saved.id,
      titleHmac: memoryContentDigest(TENANT_ID, "Private preference"),
      contentHmac: memoryContentDigest(TENANT_ID, "Never retain this sentence."),
      sourceHmac: memoryContentDigest(TENANT_ID, "manual"),
    });
    await legacyEvent("legacy-candidate", "memory.reconciliation.detected", {
      candidateMemoryId: saved.id,
      candidateContentSha256: LEGACY_DIGEST,
    });
    await legacyEvent("legacy-other-tenant", "memory.created", {
      memoryId: saved.id,
      contentSha256: LEGACY_DIGEST,
    }, OTHER_TENANT_ID);

    const forgotten = await store.forgetMemoryWithReceipt(saved.id, {
      tenantId: TENANT_ID,
    });
    const forgottenAt = forgotten?.memory.forgottenAt;
    expect(forgottenAt).toEqual(expect.any(String));

    const created = await payloadOf(createdId);
    expect(created).toMatchObject({ memoryId: saved.id, digestsForgottenAt: forgottenAt });
    for (const field of ["titleHmac", "contentHmac", "sourceHmac"]) {
      expect(created).not.toHaveProperty(field);
    }
    expect(await payloadOf(`memory_mutation_created_${descendant.id}`))
      .toMatchObject({ memoryId: descendant.id, digestsForgottenAt: forgottenAt });
    expect(await payloadOf(`memory_mutation_created_${descendant.id}`))
      .not.toHaveProperty("contentHmac");
    expect(await payloadOf("legacy-candidate")).toEqual({
      candidateMemoryId: saved.id,
      digestsForgottenAt: forgottenAt,
    });
    expect(await payloadOf(`memory_mutation_created_${kept.id}`)).toMatchObject({
      contentHmac: memoryContentDigest(TENANT_ID, "Keep this sentence."),
    });
    expect(await payloadOf("legacy-other-tenant")).toEqual({
      memoryId: saved.id,
      contentSha256: LEGACY_DIGEST,
    });
  });

  it("deletes the digests a correction and a review keep with the memory they name", async () => {
    const store = await import("@/lib/memory/store");
    const context = {
      tenantId: TENANT_ID,
      actorId: "actor:owner",
      executionScope: scope(),
    };
    const original = await store.saveMemory({
      tenantId: TENANT_ID,
      title: "Office day",
      content: "The office day is Tuesday.",
      assertedBy: "user",
      confidence: 0.9,
    });
    const correction = await store.correctMemory(original.id, {
      content: "The office day is Wednesday.",
    }, context);
    const correctedId = correction!.corrected.id;
    const proposed = await store.correctMemory(correctedId, {
      content: "The office day is Thursday.",
      contradiction: true,
    }, context);
    const candidateId = proposed!.corrected.id;
    await store.resolveMemoryReconciliationReview(
      proposed!.review!.id,
      "confirm_candidate",
      context,
    );
    const correctedEvent = () =>
      payloadOfType("memory.corrected", "correctedMemoryId", correctedId);
    const resolvedEvent = () => payloadOfType(
      "memory.reconciliation.resolved",
      "candidateMemoryId",
      candidateId,
    );
    expect(await correctedEvent()).toMatchObject({
      correctedTitleHmac: memoryContentDigest(TENANT_ID, "Office day"),
      correctedContentHmac: memoryContentDigest(
        TENANT_ID,
        "The office day is Wednesday.",
      ),
    });
    expect(await resolvedEvent()).toMatchObject({
      candidateTitleHmac: memoryContentDigest(TENANT_ID, "Office day"),
      candidateContentHmac: memoryContentDigest(
        TENANT_ID,
        "The office day is Thursday.",
      ),
    });

    await store.forgetMemoryWithReceipt(candidateId, { tenantId: TENANT_ID });
    const resolved = await resolvedEvent();
    expect(resolved).toHaveProperty("digestsForgottenAt");
    expect(resolved).not.toHaveProperty("candidateTitleHmac");
    expect(resolved).not.toHaveProperty("candidateContentHmac");
    expect(await correctedEvent()).not.toHaveProperty("digestsForgottenAt");

    await store.forgetMemoryWithReceipt(correctedId, { tenantId: TENANT_ID });
    const corrected = await correctedEvent();
    expect(corrected).toHaveProperty("digestsForgottenAt");
    expect(corrected).not.toHaveProperty("correctedTitleHmac");
    expect(corrected).not.toHaveProperty("correctedContentHmac");
  });

  it("derives a governed memory's id from its text only under the server secret", async () => {
    const store = await import("@/lib/memory/store");
    const input = {
      tenantId: TENANT_ID,
      title: "Id source",
      content: "The id is derived from this sentence.",
      source: "manual",
      executionScope: scope(),
    };
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "forget-digests-secret-one-0123456789");
    const first = await store.saveMemory(input);
    expect((await store.saveMemory(input)).id).toBe(first.id);

    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "forget-digests-secret-two-0123456789");
    expect((await store.saveMemory(input)).id).not.toBe(first.id);
  });

  it("changes only the named fields of the named events that name the id", async () => {
    const rule = {
      type: "memory.created",
      idField: "memoryId",
      digestFields: ["contentSha256"],
    };
    await legacyEvent("named", "memory.created", {
      memoryId: "memory-1",
      contentSha256: LEGACY_DIGEST,
      titleSha256: LEGACY_DIGEST,
    });
    await legacyEvent("other-id", "memory.created", {
      memoryId: "memory-2",
      contentSha256: LEGACY_DIGEST,
    });
    await legacyEvent("other-field", "memory.created", {
      candidateMemoryId: "memory-1",
      contentSha256: LEGACY_DIGEST,
    });
    await legacyEvent("other-type", "memory.feedback_applied", {
      memoryId: "memory-1",
      contentSha256: LEGACY_DIGEST,
    });
    await legacyEvent("no-digest", "memory.created", { memoryId: "memory-1" });

    await expect(forgetEventDigests({
      tenantId: TENANT_ID,
      ids: ["memory-1", ""],
      rules: [rule],
      forgottenAt: "2026-09-30T00:00:00.000Z",
    })).resolves.toBe(1);

    expect(await payloadOf("named")).toEqual({
      memoryId: "memory-1",
      titleSha256: LEGACY_DIGEST,
      digestsForgottenAt: "2026-09-30T00:00:00.000Z",
    });
    for (const eventId of ["other-id", "other-field", "other-type"]) {
      expect(await payloadOf(eventId)).toMatchObject({ contentSha256: LEGACY_DIGEST });
    }
    expect(await payloadOf("no-digest")).toEqual({ memoryId: "memory-1" });
    await expect(forgetEventDigests({
      tenantId: TENANT_ID,
      ids: [],
      rules: [rule],
      forgottenAt: "2026-09-30T00:00:00.000Z",
    })).resolves.toBe(0);
  });
});
