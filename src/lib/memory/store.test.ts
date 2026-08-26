import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-memory-"),
  );
  delete process.env.DATABASE_URL;
});

describe("memory persistence safety (file mode)", () => {
  it("redacts credentials before durable storage and drops stale embeddings", async () => {
    const store = await import("@/lib/memory/store");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const record = await store.saveMemory({
      tenantId: "tenant-a",
      title: secret,
      content: "postgresql://operator:password@example.test:5432/app",
      source: "https://operator:password@example.test/private",
      tags: ["github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      embedding: [0.1, 0.2],
    });

    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.title).toBe("[redacted-api-key]");
    expect(record.content).toBe("[redacted-connection-url]");
    expect(record.source).toBe("[redacted-credential-url]");
    expect(record.embedding).toBeUndefined();

    const [stored] = await store.listMemories({
      tenantId: "tenant-a",
      limit: 1,
    });
    expect(stored).toEqual(record);
  });

  it("returns the original record for a repeated idempotent write", async () => {
    const store = await import("@/lib/memory/store");
    const first = await store.saveMemory({
      id: "workflow_report_run_123",
      tenantId: "tenant-idempotent",
      title: "Original report",
      content: "The durable report body.",
    });
    const repeated = await store.saveMemory({
      id: "workflow_report_run_123",
      tenantId: "tenant-idempotent",
      title: "A late replay must not overwrite",
      content: "Different replay content.",
    });

    expect(repeated).toEqual(first);
    await expect(
      store.listMemories({ tenantId: "tenant-idempotent" }),
    ).resolves.toEqual([first]);
  });

  it("persists an idempotent memory batch in input order", async () => {
    const store = await import("@/lib/memory/store");
    const inputs = [
      {
        id: "batch-one",
        tenantId: "tenant-batch",
        title: "First",
        content: "First durable memory.",
      },
      {
        id: "batch-two",
        tenantId: "tenant-batch",
        title: "Second",
        content: "Second durable memory.",
      },
    ];

    const first = await store.saveMemories(inputs);
    const replayed = await store.saveMemories(
      inputs.map((input) => ({ ...input, title: "Must not overwrite" })),
    );

    expect(first.map((memory) => memory.id)).toEqual([
      "batch-one",
      "batch-two",
    ]);
    expect(replayed).toEqual(first);
  });

  it("preserves correction lineage and excludes superseded claims from recall", async () => {
    const store = await import("@/lib/memory/store");
    const original = await store.saveMemory({
      tenantId: "tenant-claims",
      title: "Preferred planning day",
      content: "Planning happens on Monday.",
      assertedBy: "user",
      confidence: 0.9,
    });
    const result = await store.correctMemory(original.id, {
      content: "Planning happens on Friday.",
      confidence: 1,
      embedding: [0.25, 0.75],
    }, { tenantId: "tenant-claims", actorId: "user-1" });

    expect(result?.previous.claimStatus).toBe("superseded");
    expect(result?.corrected.supersedesId).toBe(original.id);
    expect(result?.corrected.assertedBy).toBe("user");
    expect(result?.corrected.embedding).toEqual([0.25, 0.75]);
    const recalled = await store.searchMemories("planning happens", { tenantId: "tenant-claims" });
    expect(recalled.map((item) => item.record.id)).toEqual([result?.corrected.id]);
  });

  it("scrubs forgotten content and removes it from list and search", async () => {
    const store = await import("@/lib/memory/store");
    const memory = await store.saveMemory({ tenantId: "tenant-forget", title: "Private preference", content: "Never retain this sentence." });
    const forgotten = await store.forgetMemory(memory.id, { tenantId: "tenant-forget" });
    expect(forgotten).toMatchObject({ claimStatus: "forgotten", title: "[forgotten]", content: "" });
    await expect(store.listMemories({ tenantId: "tenant-forget" })).resolves.toEqual([]);
    await expect(store.searchMemories("retain sentence", { tenantId: "tenant-forget" })).resolves.toEqual([]);
  });

  it("reinforces useful run memories and quarantines corrected run claims", async () => {
    const store = await import("@/lib/memory/store");
    const useful = await store.saveMemory({
      tenantId: "tenant-learning",
      title: "Useful preference",
      content: "Prefer a concise summary.",
      assertedBy: "agent",
      confidence: 0.6,
      evidenceRefs: ["run:useful-run"],
    });
    await expect(store.applyRunMemoryFeedback("useful-run", "useful", { tenantId: "tenant-learning" }))
      .resolves.toEqual([useful.id]);
    expect((await store.getMemory(useful.id, { tenantId: "tenant-learning" }))?.confidence).toBeCloseTo(0.7);
    await expect(store.applyRunMemoryFeedback("useful-run", "useful", { tenantId: "tenant-learning" }))
      .resolves.toEqual([]);
    expect((await store.getMemory(useful.id, { tenantId: "tenant-learning" }))?.confidence).toBeCloseTo(0.7);

    const corrected = await store.saveMemory({
      tenantId: "tenant-learning",
      title: "Wrong preference",
      content: "Always write long answers.",
      assertedBy: "agent",
      confidence: 0.9,
      evidenceRefs: ["run:corrected-run"],
    });
    await expect(store.applyRunMemoryFeedback("corrected-run", "needs_work", { tenantId: "tenant-learning" }))
      .resolves.toEqual([corrected.id]);
    const quarantined = await store.getMemory(corrected.id, { tenantId: "tenant-learning" });
    expect(quarantined).toMatchObject({ claimStatus: "contradicted", confidence: 0.35 });
    await expect(store.searchMemories("long answers", { tenantId: "tenant-learning" })).resolves.toEqual([]);
  });
});
