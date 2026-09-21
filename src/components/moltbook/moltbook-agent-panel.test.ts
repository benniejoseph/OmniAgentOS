import { describe, expect, it } from "vitest";

import { safeMoltbookUrl } from "@/components/moltbook/moltbook-agent-panel";

describe("Moltbook agent panel", () => {
  it("opens only exact HTTPS Moltbook links", () => {
    expect(safeMoltbookUrl("https://www.moltbook.com/claim/abc")).toBe(
      "https://www.moltbook.com/claim/abc",
    );
    expect(safeMoltbookUrl("http://www.moltbook.com/claim/abc")).toBeUndefined();
    expect(safeMoltbookUrl("https://moltbook.com/claim/abc")).toBeUndefined();
    expect(
      safeMoltbookUrl("https://www.moltbook.com.attacker.example/claim/abc"),
    ).toBeUndefined();
    expect(safeMoltbookUrl("not a URL")).toBeUndefined();
  });
});
