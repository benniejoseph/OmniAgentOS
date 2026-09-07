import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  statement: "",
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getDatabaseTenantContext: () => "tenant:test",
  getSql: () => mocks.query,
  hasDatabaseUrl: () => true,
  runWithDatabaseSystemScope: async (
    _reason: string,
    operation: () => unknown,
  ) => operation(),
}));

import { listAgentRunSummaries } from "@/lib/runs/store";

describe("agent run summary query", () => {
  beforeEach(() => {
    mocks.statement = "";
    mocks.query.mockReset();
    mocks.query.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        mocks.statement = strings.reduce(
          (statement, part, index) =>
            `${statement}${part}${index < values.length ? "$value" : ""}`,
          "",
        );
        return Promise.resolve([{
          id: "run:test",
          tenant_id: "tenant:test",
          owner_actor_id: "actor:test",
          mode: "research",
          status: "completed",
          prompt: "Summarize the evidence",
          response: "Complete",
          grounding: null,
          feedback: null,
          error: null,
          continuation: null,
          agent_id: "atlas",
          specialist_ids: ["atlas"],
          started_at: "2026-09-07T10:00:00.000Z",
          completed_at: "2026-09-07T10:01:00.000Z",
        }]);
      },
    );
  });

  it("selects the required owner identity used by the shared row parser", async () => {
    const runs = await listAgentRunSummaries(8, { tenantId: "tenant:test" });

    expect(mocks.statement).toMatch(/SELECT\s+id, tenant_id, owner_actor_id,/);
    expect(runs).toMatchObject([{
      id: "run:test",
      tenantId: "tenant:test",
      ownerActorId: "actor:test",
      agentId: "atlas",
    }]);
  });
});
