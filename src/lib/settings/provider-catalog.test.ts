import { describe, expect, it } from "vitest";

import { inferProviderModelCapabilities } from "@/lib/settings/provider-catalog";

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
});
