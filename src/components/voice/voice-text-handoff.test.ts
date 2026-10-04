import { describe, expect, it } from "vitest";
import { voiceTextDraft } from "./voice-text-handoff";

describe("voice text handoff", () => {
  it("preserves a typed draft above the transcript instead of replacing it", () => {
    expect(voiceTextDraft("Typed context", " Spoken follow-up ")).toBe("Typed context\n\nSpoken follow-up");
  });
  it("moves a transcript into an empty editable draft", () => {
    expect(voiceTextDraft("", " Review this ")).toBe("Review this");
  });
  it("refuses empty or oversized combined drafts without truncating them", () => {
    expect(() => voiceTextDraft("draft", " ")).toThrow();
    expect(() => voiceTextDraft("a".repeat(100_000), "speech")).toThrow();
  });
});
