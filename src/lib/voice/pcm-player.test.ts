import { describe, expect, it } from "vitest";
import {
  Pcm16ChunkDecoder,
  splitSpeechText,
} from "@/lib/voice/pcm-player";

describe("streaming PCM decoder", () => {
  it("decodes little-endian signed samples", () => {
    const decoder = new Pcm16ChunkDecoder();
    const samples = decoder.decode(new Uint8Array([
      0x00, 0x00,
      0xff, 0x7f,
      0x00, 0x80,
    ]));

    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(0.999969, 5);
    expect(samples[2]).toBe(-1);
  });

  it("preserves one trailing byte across transport chunks", () => {
    const decoder = new Pcm16ChunkDecoder();
    expect(decoder.decode(new Uint8Array([0x00]))).toHaveLength(0);
    const samples = decoder.decode(new Uint8Array([0x40, 0x00, 0xc0]));

    expect(samples).toHaveLength(2);
    expect(samples[0]).toBe(0.5);
    expect(samples[1]).toBe(-0.5);
  });

  it("drops a reset trailing byte rather than joining unrelated streams", () => {
    const decoder = new Pcm16ChunkDecoder();
    decoder.decode(new Uint8Array([0xff]));
    decoder.reset();
    expect(decoder.decode(new Uint8Array([0x00, 0x40]))[0]).toBe(0.5);
  });
});

describe("speech text chunking", () => {
  it("keeps bounded chunks in their original order", () => {
    const text = "One sentence. Two longer words together. Final sentence.";
    const chunks = splitSpeechText(text, 24);

    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-splits a token that is larger than the provider limit", () => {
    const chunks = splitSpeechText("abcdefghij", 4);

    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
  });
});
