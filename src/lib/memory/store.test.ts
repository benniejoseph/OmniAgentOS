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
});
