import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./integration-truth-panel.tsx", import.meta.url),
  "utf8",
);
const domainSource = readFileSync(
  new URL("../app-shell/domain-console.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("./integrations-workspace.tsx", import.meta.url),
  "utf8",
);

describe("Integrations truth client boundary", () => {
  it("loads one private truth projection and rejects unknown contract versions", () => {
    expect(source).toContain('fetch("/api/integrations/overview"');
    expect(source).toContain('payload.overview?.version !== OVERVIEW_VERSION');
    expect(source).toContain('Catalog ideas never count as connected');
    expect(source).toContain('Unknown never means free');
  });

  it("labels generic catalog records as not installed without success styling", () => {
    expect(domainSource).toContain('meta: `${stringValue(item.adapter, "adapter")} · not installed`');
    expect(domainSource).toContain('tone: "neutral"');
    expect(domainSource).not.toContain('tone: stringValue(item.status) === "planned" ? "neutral" : "success"');
  });

  it("uses one responsive status hierarchy and keeps setup controls secondary", () => {
    expect(source).toContain('title="Google Workspace"');
    expect(source).toContain("Technical details");
    expect(source).toContain("Available integrations");
    expect(workspaceSource).toContain('<DomainConsole domain="integrations" presentation="embedded" />');
    expect(domainSource).toContain('presentation === "embedded"');
    expect(domainSource).toContain('aria-controls={`${value}-connections`}');
    expect(domainSource).toContain("Personal sources");
    expect(domainSource).toContain("MCP servers");
    expect(domainSource).toContain("REST APIs");
  });
});
