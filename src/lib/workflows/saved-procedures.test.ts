import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { routeAgentRequest } from "@/lib/orchestration/supervisor";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-saved-procedures-"),
  );
  delete process.env.DATABASE_URL;
});

describe("saved procedure contracts", () => {
  it("loads only trusted workspace procedure records within tenant scope", async () => {
    const { saveMemory } = await import("@/lib/memory/store");
    const procedures = await import("@/lib/workflows/saved-procedures");
    const contract = {
      schemaVersion: 1,
      id: "workflow:portfolio-blog",
      aliases: ["Run portfolio blog automation"],
      toolBindings: [{
        toolId: "mcp:github:actions_run_trigger",
        input: { owner: "example", repo: "portfolio", workflow_id: "blog.yml", ref: "main" },
      }],
    };
    await saveMemory({
      tenantId: "tenant-a",
      type: "procedure",
      title: "Portfolio blog",
      content: JSON.stringify(contract),
      tags: [procedures.SAVED_PROCEDURE_V1_TAG],
      scope: "workspace",
      source: "manual",
      assertedBy: "user",
    });
    await saveMemory({
      tenantId: "tenant-b",
      type: "procedure",
      title: "Other tenant",
      content: JSON.stringify({ ...contract, id: "workflow:other-tenant" }),
      tags: [procedures.SAVED_PROCEDURE_V1_TAG],
      scope: "workspace",
      source: "manual",
      assertedBy: "user",
    });
    await saveMemory({
      tenantId: "tenant-a",
      type: "procedure",
      title: "Untrusted import",
      content: JSON.stringify({ ...contract, id: "workflow:untrusted" }),
      tags: [procedures.SAVED_PROCEDURE_V1_TAG],
      scope: "workspace",
      source: "import",
      assertedBy: "import",
    });

    const loaded = await procedures.listSavedProcedures({
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: "workflow:portfolio-blog",
      aliases: ["run portfolio blog automation"],
      requiredToolIds: ["mcp:github:actions_run_trigger"],
    });

    const decision = routeAgentRequest(
      "Please run portfolio blog automation",
      "orchestrate",
      undefined,
      procedures.toSupervisorKnownProcedures(loaded),
    );
    expect(decision).toMatchObject({
      route: "durable_workflow",
      procedure: {
        workflowId: "workflow:portfolio-blog",
        requiredToolIds: ["mcp:github:actions_run_trigger"],
      },
    });
  });

  it("detects a changed workflow snapshot before planning", async () => {
    const procedures = await import("@/lib/workflows/saved-procedures");
    const procedure = {
      id: "workflow:release",
      aliases: ["run release"],
      requiredToolIds: ["http.request"],
      toolBindings: [{ toolId: "http.request", input: { method: "POST", url: "https://example.test/release" } }],
      sourceMemoryId: "memory-release",
    };
    const snapshot = procedures.buildWorkflowProcedureSnapshot(procedure, "run release");
    expect(procedures.parseWorkflowProcedureSnapshot(snapshot)).toEqual(snapshot);
    expect(procedures.parseWorkflowProcedureSnapshot({
      ...snapshot,
      toolBindings: [{ toolId: "http.request", input: { method: "DELETE", url: "https://example.test/release" } }],
    })).toBeUndefined();
  });
});
