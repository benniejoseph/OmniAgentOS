import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908004500_p10_7_resumable_media_processing.sql",
    import.meta.url,
  ),
  "utf8",
);
const databaseClient = readFileSync(
  new URL("../db/client.ts", import.meta.url),
  "utf8",
);

describe("P10.7 resumable media migration", () => {
  it("stores immutable digest-bound media revisions and monotonic heads", () => {
    expect(migration).toContain("omni_capture_media_revisions_immutable");
    expect(migration).toContain("Capture media revisions are immutable");
    expect(migration).toContain(
      "NEW.processing_generation <> OLD.processing_generation + 1",
    );
    expect(migration).toContain("REFERENCES omni_capture_media_revisions");
  });

  it("adds structured segment checkpoints and explicit raw-audio deletion", () => {
    expect(migration).toContain("media_transcript JSONB");
    expect(migration).toContain("media_transcript_sha256 TEXT");
    expect(migration).toContain("raw_audio_deleted_at TIMESTAMPTZ");
    expect(migration).toContain("ALTER COLUMN audio_data DROP NOT NULL");
    expect(migration).toContain("omni_capture_segments_raw_audio_check");
  });

  it("keeps media output owner-scoped and runtime writes narrow", () => {
    expect(migration).toContain("AS RESTRICTIVE FOR ALL");
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON omni_capture_media_revisions TO omni_runtime",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON omni_capture_media_heads TO omni_runtime",
    );
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
  });

  it("records ordered migration 135 after the meeting domain", () => {
    expect(migration).toContain("version = 134");
    expect(migration).toContain("135,");
    expect(migration).toContain("resumable_capture_media_v1");
    expect(databaseClient).toContain("ensureResumableCaptureMediaV1");
    expect(databaseClient).toContain('"omni_capture_media_heads"');
    expect(databaseClient).toContain('"omni_capture_media_revisions"');
  });
});
