import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { safeMoltbookUrl } from "@/components/moltbook/moltbook-agent-panel";

const panel = readFileSync(
  "src/components/moltbook/moltbook-agent-panel.tsx",
  "utf8",
);
const arsenal = readFileSync(
  "src/components/agent-arsenal-workspace.tsx",
  "utf8",
);

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
    expect(safeMoltbookUrl("https://user@www.moltbook.com/claim/abc"))
      .toBeUndefined();
    expect(safeMoltbookUrl("https://www.moltbook.com:444/claim/abc"))
      .toBeUndefined();
    expect(safeMoltbookUrl("not a URL")).toBeUndefined();
  });
});

describe("Moltbook Agent console boundaries", () => {
  it("holds ambiguous registration outcomes without offering a retry", () => {
    expect(panel).not.toContain("retry_registration");
    expect(panel).not.toContain("Retry registration");
    expect(panel).toContain("Registration is held");
  });

  it("shows management only for the exact isolated Moltbook boundary", () => {
    expect(arsenal).toContain(
      "isExactMoltbookAgentCapabilityBoundary(selected.custom)",
    );
    expect(arsenal).toContain("{selectedIsExactMoltbook ? (");
    expect(arsenal).toContain(
      "selected.custom?.manageable === true && !selectedIsExactMoltbook",
    );
    expect(arsenal).not.toContain("selectedHasMoltbook");
  });

  it("renders uncertain and pending-verification activity as warnings", () => {
    expect(panel).toContain('["uncertain", "pending_verification"]');
    expect(panel).toContain('data-tone={tone}');
  });
});
