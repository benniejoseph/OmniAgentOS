import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgeDocument,
  listKnowledgeDocumentsBySourcePrefix,
} from "@/lib/rag/store";

// A prefix a LIKE pattern would widen: `_` and `%` match any character there.
const PREFIX = "google:work:grant_1%:mail:";
const BEFORE = "2026-09-15T00:00:00.000Z";
const EARLIER = "2026-09-01T00:00:00.000Z";
const TENANT = "listing-tenant";

describe("the knowledge documents listed under a source prefix", () => {
  let dataDir: string;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    dataDir = await mkdtemp(path.join(os.tmpdir(), "omni-knowledge-prefix-"));
    process.env.OMNIAGENT_DATA_DIR = dataDir;
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function create(source: string, createdAt: string, tenantId = TENANT) {
    vi.setSystemTime(Date.parse(createdAt));
    const { document } = await createKnowledgeDocument({
      idempotencyKey: `listing:${source}`,
      tenantId,
      title: source,
      content: `Content of ${source}`,
      source,
      sourceType: "api",
      chunks: [{ index: 0, content: `Content of ${source}` }],
    });
    return { id: document.id, source: document.source };
  }

  function list(options: { after?: string; limit?: number; createdBefore?: string } = {}) {
    return listKnowledgeDocumentsBySourcePrefix(PREFIX, {
      tenantId: TENANT,
      createdBefore: BEFORE,
      limit: 3,
      ...options,
    });
  }

  it("are the tenant's, in id order, after a position, created before a time", async () => {
    const held = [];
    for (const item of ["a", "b", "c", "d"]) {
      held.push(await create(`${PREFIX}${item}`, EARLIER));
    }
    await create(`${PREFIX}at-the-time`, BEFORE);
    await create(`${PREFIX}later`, "2026-09-20T00:00:00.000Z");
    await create("google:work:grantX1%:mail:e", EARLIER);
    await create("google:work:grant_1zz:mail:f", EARLIER);
    await create("google:work:grant_1%:drive:g", EARLIER);
    await create(`${PREFIX}h`, EARLIER, "another-tenant");
    held.sort((left, right) => left.id < right.id ? -1 : 1);

    const first = await list();
    expect(first).toEqual(held.slice(0, 3));
    const second = await list({ after: first[2].id });
    expect(second).toEqual(held.slice(3));
    await expect(list({ after: second[0].id })).resolves.toEqual([]);
  });

  it("lists at least one document a call", async () => {
    await create(`${PREFIX}a`, EARLIER);
    await create(`${PREFIX}b`, EARLIER);

    await expect(list({ limit: 0 })).resolves.toHaveLength(1);
    await expect(list({ limit: -2 })).resolves.toHaveLength(1);
    await expect(list({ limit: Number.NaN })).resolves.toHaveLength(1);
    await expect(list({ limit: 1.9 })).resolves.toHaveLength(1);
  });

  it("are refused without a prefix or a time", async () => {
    await expect(listKnowledgeDocumentsBySourcePrefix("", {
      tenantId: TENANT,
      createdBefore: BEFORE,
      limit: 3,
    })).rejects.toThrow("A source prefix is required.");
    await expect(list({ createdBefore: "never" }))
      .rejects.toThrow("A creation bound is required.");
  });
});
