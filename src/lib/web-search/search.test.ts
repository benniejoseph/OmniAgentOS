import { describe, expect, it } from "vitest";
import { shouldUseLiveWebSearch } from "@/lib/web-search/search";

describe("live web search routing", () => {
  it("honors explicit external-tool and web-search refusals", () => {
    expect(shouldUseLiveWebSearch("Verify this citation, but do not use external tools.")).toBe(false);
    expect(shouldUseLiveWebSearch("Verify this citation, but do not use any external tools or web search.")).toBe(false);
    expect(shouldUseLiveWebSearch("Use memory only; do not use the web.")).toBe(false);
    expect(shouldUseLiveWebSearch("Review the latest result without any tools.")).toBe(false);
  });

  it("honors natural browse and search refusals even when freshness terms are present", () => {
    expect(shouldUseLiveWebSearch("Compare current AI-agent patterns, but don't browse the web.")).toBe(false);
    expect(shouldUseLiveWebSearch("Review the latest model, but do not browse the internet.")).toBe(false);
    expect(shouldUseLiveWebSearch("Compare current models, but don’t browse the web.")).toBe(false);
    expect(shouldUseLiveWebSearch("Check the current API without browsing the web.")).toBe(false);
    expect(shouldUseLiveWebSearch("Discuss recent releases without searching the internet.")).toBe(false);
    expect(shouldUseLiveWebSearch("Summarize current model support; dont search web.")).toBe(false);
  });

  it("still routes genuinely current requests to live search", () => {
    expect(shouldUseLiveWebSearch("What is the latest product changelog?")).toBe(true);
    expect(shouldUseLiveWebSearch("Browse the web for current model availability.")).toBe(true);
    expect(shouldUseLiveWebSearch("Search the internet for today's API changelog.")).toBe(true);
    expect(shouldUseLiveWebSearch("Do not browse old notes; search the web for the current API docs.")).toBe(true);
  });
});
