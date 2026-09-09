import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { databaseSchemaMigrations } from "@/lib/db/client";

describe("configurable AI model scopes migration", () => {
  it("admits every specialist assignment and its usage receipt", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260909213000_configurable_ai_model_scopes.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 153,
      name: "configurable_ai_model_scopes_v1",
      checksum:
        "7e8e236c9c3c3d0f19dfc32c942ee6bd37aeed0da8f192057c9ecebb78412745",
    });
    for (const scope of [
      "audio_diarization",
      "web_search",
      "image_generation",
      "speech_synthesis",
      "realtime_transcription",
    ]) {
      expect(migration).toContain(`'${scope}'`);
    }
    expect(migration).toContain("credential_source = 'tenant_vault'");
    expect(migration).toContain("requires exact predecessor 152");
  });
});
