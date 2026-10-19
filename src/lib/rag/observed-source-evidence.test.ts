import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ records: vi.fn(), binding: vi.fn(), knowledge: vi.fn(async () => []) }));
vi.mock("@/lib/tools/audit-store", () => ({ getToolExecutionsByIds: mocks.records }));
vi.mock("@/lib/tools/execution-scope", () => ({ getToolExecutionScopeBinding: mocks.binding }));
vi.mock("@/lib/rag/store", () => ({ getCanonicalKnowledgeEvidenceByChunkIds: mocks.knowledge }));
import { buildClaimGroundingReport, buildWebCitationSources } from "@/lib/rag/citations";
import { createExecutionScope } from "@/lib/security/execution-scope";

const content = "The public launch of the example service is scheduled for 19 October 2026 in Bengaluru.";
const sources = buildWebCitationSources([{ url: "https://example.com/launch", title: "Launch" }], "2026-10-19T08:00:00.000Z").map(source => ({ ...source, toolExecutionId: "read-1" }));
const scope = createExecutionScope({ tenantId: "tenant-a", initiatingActorId: "owner-a", executingPrincipalType: "agent", executingPrincipalId: "atlas-a", correlationId: "run-a", purpose: "agent.run" });
const receipt = () => ({ id: "read-1", tenantId: "tenant-a", actorId: "owner-a", toolId: "web.read", status: "executed", dryRun: false, riskLevel: 0,
  output: { url: sources[0].url, citationId: sources[0].citationId, content, fetchedAt: "2026-10-19T08:00:00.000Z", contentTrust: "untrusted" } });
const report = (response = content, evaluatedAt = "2026-10-19T08:01:00.000Z") => buildClaimGroundingReport({ runId: "run-a", response: `${response} [${sources[0].citationId}]`, sources, executionScope: scope, evaluatedAt });

describe("governed source observation evidence", () => {
  beforeEach(() => { mocks.records.mockResolvedValue([receipt()]); mocks.binding.mockResolvedValue({ toolId: "web.read", executionScope: { ...scope, purpose: "agent.tool.execute" } }); });
  it("supports an exact claim from the actual source snapshot without knowledge ingestion", async () => {
    expect((await report()).status).toBe("verified");
  });
  it("does not verify a contradicted or invented claim", async () => {
    expect((await report(content.replace("19 October", "25 December"))).status).toBe("missing");
  });
  it("does not accept another actor's receipt", async () => {
    mocks.records.mockResolvedValue([{ ...receipt(), actorId: "someone-else" }]);
    expect((await report()).status).toBe("missing");
  });
  it("does not accept a receipt from another run", async () => {
    mocks.binding.mockResolvedValue({ toolId: "web.read", executionScope: { ...scope, correlationId: "other-run" } });
    expect((await report()).status).toBe("missing");
  });
  it("does not treat stale, future or dry-run source reads as fresh evidence", async () => {
    expect((await report(content, "2026-10-19T08:06:00.000Z")).status).toBe("missing");
    expect((await report(content, "2026-10-19T07:59:00.000Z")).status).toBe("missing");
    mocks.records.mockResolvedValue([{ ...receipt(), dryRun: true }]);
    expect((await report()).status).toBe("missing");
  });
});
