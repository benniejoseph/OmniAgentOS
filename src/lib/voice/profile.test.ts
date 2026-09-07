import { describe, expect, it } from "vitest";
import {
  ASAEL_VOICE_ENCODING,
  ASAEL_VOICE_MODEL,
  ASAEL_VOICE_NAME,
  ASAEL_VOICE_PROFILE_VERSION,
  ASAEL_VOICE_SAMPLE_RATE,
  versionedVoiceProfile,
} from "@/lib/voice/profile";

describe("versioned Asael voice profile", () => {
  it("pins one streamable acoustic profile to the exact Agent definition", () => {
    const profile = versionedVoiceProfile({
      id: "scout",
      name: "Scout",
      delivery: "Curious and evidence-led.",
      definitionVersion: 3,
    });

    expect(profile).toMatchObject({
      schemaVersion: 1,
      profileVersion: ASAEL_VOICE_PROFILE_VERSION,
      provider: "openai",
      model: ASAEL_VOICE_MODEL,
      voice: ASAEL_VOICE_NAME,
      sampleRate: ASAEL_VOICE_SAMPLE_RATE,
      encoding: ASAEL_VOICE_ENCODING,
      agentId: "scout",
      agentDefinitionVersion: 3,
    });
    expect(profile.instructions).toContain("exactly as written");
    expect(profile.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the immutable digest when versioned delivery changes", () => {
    const first = versionedVoiceProfile({
      id: "asael",
      name: "Asael",
      delivery: "Calm.",
      definitionVersion: 1,
    });
    const second = versionedVoiceProfile({
      id: "asael",
      name: "Asael",
      delivery: "Warm.",
      definitionVersion: 2,
    });

    expect(first.sha256).not.toBe(second.sha256);
    expect(second.instructions).not.toContain("\n");
  });
});
