import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAgentService,
  createSkillService,
  deleteAgentService,
  deleteSkillService,
  previewAgentDeleteService,
  previewSkillDeleteService,
} from "@/lib/app-services/agents";
import {
  deleteConnectorService,
  previewConnectorDeleteService,
} from "@/lib/app-services/connectors";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createMcpConnectorRecord, saveMcpConnector } from "@/lib/connectors/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  listTrashReceiptsService,
  listTrashService,
  previewTrashPurgeService,
  previewTrashRestoreService,
  purgeTrashService,
  restoreTrashService,
  showTrashService,
} from "@/lib/app-services/trash";

let dataDir = "";
let priorDatabaseUrl: string | undefined;
let priorDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-app-trash-"));
  priorDatabaseUrl = process.env.DATABASE_URL;
  priorDataDir = process.env.OMNIAGENT_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDataDir === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = priorDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("P9.3 reversible application deletes", () => {
  it("requires the complete Agent trash preview and returns its effect receipt", async () => {
    const caller = appCaller("agent-delete");
    const created = await createAgentService(caller, {
      name: "Planner",
      role: "Planning specialist",
      description: "Plans bounded work.",
      instructions: "Create a dependency-aware plan and state assumptions clearly.",
      status: "ready",
      accent: "emerald",
      modelPolicy: "auto",
      autonomy: "governed",
      approvalPolicy: "risk_based",
      memoryScope: "all",
      skillIds: [],
      toolIds: [],
    });
    const preview = await previewAgentDeleteService(caller, {
      id: created.data.agent.id,
    });
    expect(preview.data).toMatchObject({
      reversible: true,
      compensation: "equivalent_agent_identity",
      preview: { action: "trash", resourceType: "custom_agent" },
    });
    const moved = await deleteAgentService(caller, {
      id: created.data.agent.id,
      preview: preview.data.preview!,
    });
    expect(moved.data).toMatchObject({
      movedToTrash: true,
      trash: { state: "retained", resourceId: created.data.agent.id },
      effectReceipt: { action: "trash", outcome: "applied" },
    });
    await expect(deleteAgentService(caller, {
      id: created.data.agent.id,
      preview: preview.data.preview!,
    })).resolves.toMatchObject({
      data: { effectReceipt: { receiptSha256: moved.data.effectReceipt.receiptSha256 } },
    });
  });

  it("moves Skills and connectors to retained trash instead of permanent deletion", async () => {
    const caller = appCaller("resource-delete");
    const skill = await createSkillService(caller, {
      name: "Summarize",
      description: "Summarizes evidence.",
      instructions: "Summarize only the supplied grounded evidence.",
      category: "analysis",
      status: "active",
      toolIds: [],
      tags: [],
      knowledgeTags: [],
    });
    const skillPreview = await previewSkillDeleteService(caller, {
      id: skill.data.skill.id,
    });
    await expect(deleteSkillService(caller, {
      id: skill.data.skill.id,
      preview: skillPreview.data.preview!,
    })).resolves.toMatchObject({
      data: { movedToTrash: true, trash: { resourceType: "agent_skill" } },
    });

    const connector = createMcpConnectorRecord({
      tenantId: "tenant-a",
      name: "Search MCP",
      endpoint: "https://search.example.test/mcp",
    });
    await saveMcpConnector(connector, {
      executionScope: caller.executionScope!,
    });
    const connectorPreview = await previewConnectorDeleteService(caller, {
      kind: "mcp",
      connectorId: connector.id,
    });
    await expect(deleteConnectorService(caller, {
      kind: "mcp",
      connectorId: connector.id,
      preview: connectorPreview.data.preview!,
    })).resolves.toMatchObject({
      data: { movedToTrash: true, trash: { resourceType: "mcp_connector" } },
    });
  });

  it("lists metadata-only trash, restores safely, and emits final purge receipts", async () => {
    const caller = appCaller("trash-lifecycle");
    const first = await createSkillService(caller, skillInput("Restorable"));
    const firstPreview = await previewSkillDeleteService(caller, {
      id: first.data.skill.id,
    });
    const moved = await deleteSkillService(caller, {
      id: first.data.skill.id,
      preview: firstPreview.data.preview!,
    });
    const listed = await listTrashService(caller, {});
    expect(listed.data.items).toEqual([
      expect.objectContaining({ trashId: moved.data.trash.trashId }),
    ]);
    expect(JSON.stringify(listed.data)).not.toContain("instructions");
    await expect(showTrashService(caller, {
      trashId: moved.data.trash.trashId,
    })).resolves.toMatchObject({
      data: { item: { state: "retained", compensation: { kind: "exact_restore" } } },
    });
    const restorePreview = await previewTrashRestoreService(caller, {
      trashId: moved.data.trash.trashId,
    });
    await expect(restoreTrashService(caller, {
      preview: restorePreview.data.preview!,
    })).resolves.toMatchObject({
      data: { trash: { state: "restored" }, effectReceipt: { action: "restore" } },
    });

    const second = await createSkillService(caller, skillInput("Purgeable"));
    const secondPreview = await previewSkillDeleteService(caller, {
      id: second.data.skill.id,
    });
    const secondMoved = await deleteSkillService(caller, {
      id: second.data.skill.id,
      preview: secondPreview.data.preview!,
    });
    const purgePreview = await previewTrashPurgeService(caller, {
      trashId: secondMoved.data.trash.trashId,
    });
    expect(purgePreview.data).toMatchObject({
      permanent: true,
      preview: { reversible: false, action: "purge" },
    });
    const purged = await purgeTrashService(caller, {
      preview: purgePreview.data.preview!,
    });
    expect(purged.data).toMatchObject({
      trash: { state: "purged" },
      finalDeletionReceipt: { action: "purge", outcome: "applied" },
    });
    const receipts = await listTrashReceiptsService(caller, {
      trashId: secondMoved.data.trash.trashId,
    });
    expect(receipts.data.receipts.map((receipt) => receipt.action).sort())
      .toEqual(["purge", "trash"]);
  });
});

function skillInput(name: string) {
  return {
    name,
    description: `${name} description.`,
    instructions: `${name} instructions with enough detail.`,
    category: "analysis" as const,
    status: "active" as const,
    toolIds: [],
    tags: [],
    knowledgeTags: [],
  };
}

function appCaller(correlation: string) {
  const context = {
    tenantId: "tenant-a",
    actorId: "alice",
    role: "admin" as const,
    source: "headers" as const,
  };
  return createAppServiceCaller({
    context,
    idempotencyKey: correlation,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: correlation,
      purpose: "Test reversible application deletion.",
    }),
  });
}
