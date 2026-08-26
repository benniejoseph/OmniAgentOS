import { describe, expect, it } from "vitest";
import { shouldUseLiveWebSearch } from "@/lib/web-search/search";

describe("live web search routing", () => {
  it("honors explicit external-tool and web-search refusals", () => {
    expect(shouldUseLiveWebSearch("Verify this citation, but do not use external tools.")).toBe(false);
    expect(shouldUseLiveWebSearch("Verify this citation, but do not use any external tools or web search.")).toBe(false);
    expect(shouldUseLiveWebSearch("Use memory only; do not use the web.")).toBe(false);
    expect(shouldUseLiveWebSearch("Review the latest result without any tools.")).toBe(false);
  });

  it("still routes genuinely current requests to live search", () => {
    expect(shouldUseLiveWebSearch("What is the latest product changelog?")).toBe(true);
  });
});
