import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  queries: [] as Array<{ text: string; values: unknown[] }>,
  sql: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureSchema,
  getDatabaseTenantContext: () => undefined,
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
}));

import {
  getActorOwnedKnowledgeForCognition,
  listActorOwnedKnowledgeDocumentsForCognition,
} from "@/lib/rag/store";
import { KNOWLEDGE_COGNIFY_PURPOSE_ID } from "@/lib/sources/purposes";

const NOW = "2026-09-10T08:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.sql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.queries.push({ text: strings.join("?"), values });
      return Promise.resolve([]);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Postgres cognition source eligibility", () => {
  it("checks current item, revision, every evidence unit, and retention atomically", async () => {
    await expect(getActorOwnedKnowledgeForCognition({
      tenantId: "tenant-postgres-cognition",
      actorId: "actor-postgres-cognition",
      documentId: "document-postgres-cognition",
    })).resolves.toBeNull();
    await expect(listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: "tenant-postgres-cognition",
      actorId: "actor-postgres-cognition",
    })).resolves.toEqual([]);

    expect(mocks.queries).toHaveLength(2);
    for (const query of mocks.queries) {
      expect(query.text).toContain("JOIN omni_source_revisions revision");
      expect(query.text).toContain(
        "item.current_revision_id = document.source_revision_id",
      );
      expect(query.text).toContain("revision.source_item_id = item.id");
      expect(query.text).toContain("item.owner_actor_id");
      expect(query.text).toContain("revision.owner_actor_id");
      expect(query.text).toContain("item.visibility = 'user_private'");
      expect(query.text).toContain("revision.visibility = 'user_private'");
      expect(query.text).toContain("item.retention_expires_at");
      expect(query.text).toContain("revision.retention_expires_at");
      expect(query.text).toContain("evidence.retention_expires_at");
      expect(query.text).toContain("evidence.extracted_at");
      expect(query.text).toContain("COUNT(DISTINCT evidence.id)");
      expect(query.text).toContain("BOOL_AND");
      expect(query.text).toContain("jsonb_agg");
      expect(query.values).toContain("tenant-postgres-cognition");
      expect(query.values).toContain("actor-postgres-cognition");
      expect(query.values).toContain(KNOWLEDGE_COGNIFY_PURPOSE_ID);
      expect(query.values).toContain(NOW);
    }
  });
});
