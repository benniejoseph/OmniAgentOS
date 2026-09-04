import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/rag/chunk";

describe("chunkText", () => {
  it("does not emit a stale overlap tail after a long paragraph", () => {
    const first = "a".repeat(700);
    const long = "b".repeat(1_050);
    const chunks = chunkText(`${first}\n\n${long}`, 1_000, 100);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe(first);
    expect(chunks[1].content).toBe("b".repeat(1_000));
    expect(chunks[2].content).toBe("b".repeat(150));
    expect(chunks.some((chunk) => chunk.content === "a".repeat(100))).toBe(false);
  });

  it("bounds overlap to one third of the chunk size", () => {
    const chunks = chunkText("x".repeat(1_000), 300, 1_000);
    expect(chunks[0].content).toHaveLength(300);
    expect(chunks[1].content.slice(0, 100)).toBe(chunks[0].content.slice(-100));
  });

  it("reports exact spans in normalized extracted text", () => {
    const input = "  first paragraph  \n\n\n second paragraph ";
    const normalized = "first paragraph\n\nsecond paragraph";
    const chunks = chunkText(input, 18, 4);

    for (const chunk of chunks) {
      expect(
        normalized.slice(chunk.characterStart, chunk.characterEnd),
      ).toBe(chunk.content);
    }
  });

  it("never splits UTF-16 surrogate pairs at chunk or overlap boundaries", () => {
    const normalized = `ab😀cd${"x".repeat(12)}😀tail`;
    const chunks = chunkText(normalized, 5, 2);

    for (const chunk of chunks) {
      expect(
        normalized.slice(chunk.characterStart, chunk.characterEnd),
      ).toBe(chunk.content);
      expect(chunk.content).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });
});
