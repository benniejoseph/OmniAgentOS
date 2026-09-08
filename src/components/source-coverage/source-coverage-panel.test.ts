import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./source-coverage-panel.tsx", import.meta.url), "utf8");
const integrations = readFileSync(new URL("../integrations/integrations-workspace.tsx", import.meta.url), "utf8");
const today = readFileSync(new URL("../today-workspace.tsx", import.meta.url), "utf8");
const memory = readFileSync(new URL("../memory-workspace.tsx", import.meta.url), "utf8");

describe("P11.9 source coverage client boundary", () => {
  it("loads the private exact-version projection and preserves the absence rule", () => {
    expect(source).toContain('fetch("/api/source-coverage", { cache: "no-store" })');
    expect(source).toContain("payload.coverage.version !== COVERAGE_VERSION");
    expect(source).toContain("Not measured yet");
    expect(source).toContain("What Asael can reliably use");
    expect(source).toContain("No provider content, raw cursors, credentials, or actor identifiers");
    expect(source).toContain("unsupported data domains");
  });

  it("places the same coverage contract on Today, Memory, and Integrations", () => {
    expect(integrations).toContain('<SourceCoveragePanel surface="integrations" />');
    expect(today).toContain('<SourceCoveragePanel surface="today" />');
    expect(memory).toContain('<SourceCoveragePanel surface="memory" />');
  });
});
