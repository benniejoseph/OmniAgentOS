import { describe, expect, it } from "vitest";
import {
  COMPANION_LANGUAGE_STYLE_VERSION,
  UNAVAILABLE_COMPANION_LANGUAGE_STYLE,
  companionLanguageStyleInstructions,
  type CompanionLanguageStyle,
} from "@/lib/companion/language-style";

describe("fixed Companion language policy", () => {
  it.each([
    ["quiet", "Do not add unsolicited jokes"],
    ["balanced", "calm, warm, concise"],
    ["expressive", "playful aside is permitted, never required"],
  ] as const)("selects only the fixed %s policy and keeps the same precedence", (intensity, policy) => {
    const text = companionLanguageStyleInstructions({
      version: COMPANION_LANGUAGE_STYLE_VERSION, source: "saved", intensity, preferenceRevision: 7,
    });
    expect(text).toContain(policy);
    expect(text).toContain(`Selection: saved; intensity: ${intensity}; preference revision: 7`);
    expect(text).toContain("follow those existing instructions");
    expect(text).toContain("requested tone and exact output format before this preference");
    expect(text).toContain("Serious or sensitive tasks, errors, uncertainty and approval decisions");
    expect(text).toContain("Acknowledgments or celebrations require a verified result");
    expect(text).toContain("cannot change permissions, approvals, tools, tool arguments");
    expect(text).toContain("does not enable audio, character visibility or motion");
  });

  it("distinguishes unconfirmed preferences from the established Balanced default", () => {
    const unavailable = companionLanguageStyleInstructions(UNAVAILABLE_COMPANION_LANGUAGE_STYLE);
    expect(unavailable).toContain("Selection: unavailable; intensity: neutral; preference revision: unconfirmed");
    expect(unavailable).toContain("do not claim a saved style was applied");
    expect(companionLanguageStyleInstructions({
      version: COMPANION_LANGUAGE_STYLE_VERSION, source: "default", intensity: "balanced", preferenceRevision: 0,
    })).toContain("Selection: default; intensity: balanced; preference revision: 0");
    expect(companionLanguageStyleInstructions()).toBe("");
  });

  it("never interpolates malformed selection text or nonnumeric revision metadata", () => {
    for (const malformed of [
      { source: "PRIVATE_INJECTION", intensity: "expressive", preferenceRevision: 7 },
      { source: "saved", intensity: "PRIVATE_INJECTION", preferenceRevision: 7 },
      { source: "saved", intensity: "quiet", preferenceRevision: "PRIVATE_INJECTION" },
      { source: "saved", intensity: "quiet", preferenceRevision: Number.POSITIVE_INFINITY },
      { source: "default", intensity: "expressive", preferenceRevision: 0 },
    ]) {
      const text = companionLanguageStyleInstructions({
        version: COMPANION_LANGUAGE_STYLE_VERSION, ...malformed,
      } as unknown as CompanionLanguageStyle);
      expect(text).toBe(companionLanguageStyleInstructions(UNAVAILABLE_COMPANION_LANGUAGE_STYLE));
      expect(text).not.toContain("PRIVATE_INJECTION");
    }
  });
});
