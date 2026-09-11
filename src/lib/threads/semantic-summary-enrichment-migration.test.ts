import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260911110000_conversation_summary_enrichments.sql",
);
const manifestPath = path.join(process.cwd(), "schema-migrations.json");
const bootstrapPath = path.join(process.cwd(), "src/lib/db/client.ts");

describe("conversation summary enrichment migration", () => {
  it("installs an actor-private, immutable, shadow-only episode boundary", async () => {
    const [migration, manifestText, bootstrap] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(manifestPath, "utf8"),
      readFile(bootstrapPath, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as Array<{
      version: number;
      name: string;
      checksum: string;
    }>;

    expect(manifest.at(-1)).toEqual({
      version: 156,
      name: "conversation_summary_enrichments_v1",
      checksum:
        "83e7878f29b3ea25df0ecb40bd94521a3e84af93f5eae6a34ad03bd4b9071a37",
    });
    expect(migration).toContain("latest_version IS DISTINCT FROM 155");
    expect(migration).toContain(
      "'83e7878f29b3ea25df0ecb40bd94521a3e84af93f5eae6a34ad03bd4b9071a37'",
    );
    expect(migration).toContain(
      "CREATE TABLE public.omni_conversation_summary_enrichments",
    );
    expect(migration).toContain("mode TEXT NOT NULL DEFAULT 'shadow'");
    expect(migration).toContain("contract ->> 'shadowOnly' = 'true'");
    expect(migration).toContain(
      "UNIQUE (tenant_id, owner_actor_id, generation_id, source_sha256)",
    );
    expect(migration).toContain("ON UPDATE RESTRICT ON DELETE CASCADE");
    expect(migration).toContain(
      "parent_summary.level IS DISTINCT FROM 'episode'",
    );
    expect(migration).toContain(
      "parent_summary.source_turn_ids IS DISTINCT FROM NEW.source_turn_ids",
    );
    expect(migration).toContain(
      "parent_summary.summary_sha256 IS DISTINCT FROM",
    );
    expect(migration).toContain(
      "contract ->> 'deterministicSummarySha256'",
    );
    expect(migration).toContain(
      "usage.purpose = 'conversation.summary.enrich.v1'",
    );
    expect(migration).toContain(
      "omni_delete_stale_conversation_summary_enrichments_v1",
    );
    expect(migration).toContain(
      "BEFORE UPDATE OF source_sha256, summary_sha256, source_turn_ids",
    );
    expect(migration).toContain(
      "omni_protect_conversation_summary_enrichment_v1",
    );
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "omni_conversation_summary_enrichments_actor_scope",
    );
    expect(migration).toContain(
      "omni_conversation_summary_events_actor_scope",
    );
    expect(migration).toContain(
      "left(stream_id, 21) <> 'conversation-summary:'",
    );
    expect(migration).toContain(
      "omni_actor_scope_v1_allows_validated",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON public.omni_conversation_summary_enrichments",
    );
    expect(migration).toContain(
      "GRANT SELECT ON public.omni_conversation_summary_enrichments",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:[A-Z, ]*\b)?(?:UPDATE|DELETE|TRUNCATE)\b/i,
    );

    expect(bootstrap).toContain(
      '"omni_conversation_summary_enrichments"',
    );
    expect(bootstrap).toContain(
      "up: ensureConversationSummaryEnrichmentsV1",
    );
    expect(bootstrap).toContain(
      "async function ensureConversationSummaryEnrichmentsV1",
    );
    expect(bootstrap).toContain(
      "CREATE POLICY omni_conversation_summary_events_actor_scope",
    );
  });
});
