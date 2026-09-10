import { afterEach, describe, expect, it, vi } from "vitest";

import { generateOpenAIImage } from "@/lib/openai/image";

describe("OpenAI image provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured model for image generation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "image-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateOpenAIImage({
      prompt: "A precise diagram",
      model: "gpt-image-configured",
      aspectRatio: "16:9",
      apiKey: "test-openai-key",
    })).resolves.toMatchObject({
      model: "gpt-image-configured",
      responseId: "image-1",
      mimeType: "image/png",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: "gpt-image-configured",
      size: "1536x1024",
    });
  });

  it("sends actor-owned source images to the edits endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("edited-image").toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await generateOpenAIImage({
      prompt: "Use a neutral background",
      model: "gpt-image-configured",
      apiKey: "test-openai-key",
      sources: [{
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        filename: "portrait.png",
      }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("model")).toBe("gpt-image-configured");
    expect(body.get("prompt")).toBe("Use a neutral background");
    expect(body.getAll("image[]")).toHaveLength(1);
  });
});
