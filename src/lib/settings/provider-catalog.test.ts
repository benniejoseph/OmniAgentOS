import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverProviderModels,
  inferProviderModelCapabilities,
} from "@/lib/settings/provider-catalog";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider model capability inference", () => {
  it("recognizes configurable image, video, and current computer-use families", () => {
    expect(inferProviderModelCapabilities("gpt-image-2.5-sunburst")).toEqual(["image"]);
    expect(inferProviderModelCapabilities("gemini-omni-1.1-flash")).toEqual(["video"]);
    expect(inferProviderModelCapabilities("gpt-6-astra")).toEqual(
      expect.arrayContaining(["text", "vision", "tools", "computer_use"]),
    );
    expect(inferProviderModelCapabilities("gemini-2.5-computer-use-preview")).toEqual(
      expect.arrayContaining(["computer_use"]),
    );
  });

  it("discovers TypeSafe models as semantic-decision-only catalog entries", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{
        name: "jev-release-2026-09",
        description: "Typed semantic decision model",
        release_date: "2026-09-01",
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverProviderModels("typesafe", {
      apiKey: "typesafe-test-key-not-a-real-secret",
    });

    expect(models).toEqual([
      expect.objectContaining({
        modelId: "jev-release-2026-09",
        displayName: "jev-release-2026-09",
        capabilities: ["semantic_decision"],
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/models",
      expect.objectContaining({
        headers: {
          authorization: "Bearer typesafe-test-key-not-a-real-secret",
        },
      }),
    );
  });
});
