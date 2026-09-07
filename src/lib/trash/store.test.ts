import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  commitTrashLifecycle,
  createTrashEntry,
  createTrashLifecyclePreview,
  createTrashPreview,
  expireTrashItems,
  getTrashItem,
  getTrashSnapshot,
  listTrashItems,
} from "@/lib/trash/store";

let dataDir = "";
let priorDatabaseUrl: string | undefined;
let priorDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-trash-"));
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

describe("P9.3 trash store", () => {
  it("keeps snapshots internal and scopes every read to the exact tenant actor", async () => {
    const alice = scope("tenant-a", "alice");
    const preview = createTrashPreview({
      resourceType: "custom_agent",
      resourceId: "agent-1",
      target: { id: "agent-1", version: 2 },
      effectSummary: "Move Agent One to trash.",
      now: "2026-09-07T10:00:00.000Z",
    });
    const created = await createTrashEntry({
      preview,
      displayLabel: "Agent One",
      target: { id: "agent-1", version: 2 },
      snapshot: { agent: { id: "agent-1", instructions: "Help carefully." } },
      compensation: {
        kind: "exact_restore",
        handlerId: "trash.restore.custom_agent",
        limitation: null,
      },
      now: "2026-09-07T10:00:01.000Z",
    }, { executionScope: alice });

    expect(created.item.state).toBe("retained");
    expect(created.receipt.action).toBe("trash");
    expect(created.item).not.toHaveProperty("snapshot");
    await expect(listTrashItems({ executionScope: scope("tenant-a", "bob") }))
      .resolves.toEqual([]);
    await expect(listTrashItems({ executionScope: scope("tenant-b", "alice") }))
      .resolves.toEqual([]);
    await expect(getTrashSnapshot(created.item.trashId, { executionScope: alice }))
      .resolves.toMatchObject({ snapshot: { agent: { id: "agent-1" } } });
  });

  it("requires a fresh exact-target preview and makes create idempotent", async () => {
    const executionScope = scope("tenant-a", "alice");
    const preview = createTrashPreview({
      resourceType: "agent_skill",
      resourceId: "skill-1",
      target: { id: "skill-1", version: 1 },
      effectSummary: "Move Skill One to trash.",
      now: "2026-09-07T10:00:00.000Z",
    });
    const input = {
      preview,
      displayLabel: "Skill One",
      target: { id: "skill-1", version: 1 },
      snapshot: { skill: { id: "skill-1" } },
      compensation: {
        kind: "exact_restore" as const,
        handlerId: "trash.restore.agent_skill",
        limitation: null,
      },
      now: "2026-09-07T10:00:05.000Z",
    };
    const first = await createTrashEntry(input, { executionScope });
    const retry = await createTrashEntry(input, { executionScope });
    expect(retry).toEqual(first);
    await expect(createTrashEntry({
      ...input,
      target: { id: "skill-1", version: 2 },
    }, { executionScope })).rejects.toThrow(/changed after preview/);
    await expect(createTrashEntry({
      ...input,
      now: "2026-09-07T10:11:00.000Z",
    }, { executionScope })).rejects.toThrow(/expired/);
  });

  it("revision-fences restore and destroys its internal snapshot", async () => {
    const executionScope = scope("tenant-a", "alice");
    const created = await createConnectorTrash(executionScope);
    const restorePreview = await createTrashLifecyclePreview(
      created.item.trashId,
      "restore",
      { executionScope, now: "2026-09-07T10:01:00.000Z" },
    );
    expect(restorePreview?.reversible).toBe(true);
    const restored = await commitTrashLifecycle(restorePreview!, {
      executionScope,
      now: "2026-09-07T10:01:01.000Z",
    });
    expect(restored.item.state).toBe("restored");
    expect(restored.receipt.action).toBe("restore");
    await expect(getTrashSnapshot(created.item.trashId, { executionScope }))
      .resolves.toBeUndefined();
    await expect(commitTrashLifecycle(restorePreview!, {
      executionScope,
      now: "2026-09-07T10:01:02.000Z",
    })).resolves.toEqual(restored);
  });

  it("makes permanent purge explicit and leaves an immutable final receipt", async () => {
    const executionScope = scope("tenant-a", "alice");
    const created = await createConnectorTrash(executionScope);
    const purgePreview = await createTrashLifecyclePreview(
      created.item.trashId,
      "purge",
      { executionScope, now: "2026-09-07T10:01:00.000Z" },
    );
    expect(purgePreview).toMatchObject({ reversible: false, action: "purge" });
    const purged = await commitTrashLifecycle(purgePreview!, {
      executionScope,
      now: "2026-09-07T10:01:01.000Z",
    });
    expect(purged).toMatchObject({
      item: { state: "purged", lifecycleRevision: 2 },
      receipt: { action: "purge", afterState: "purged", outcome: "applied" },
    });
    const persisted = JSON.parse(
      await readFile(path.join(dataDir, "trash-ledger.json"), "utf8"),
    ) as { records: Array<{ snapshot: unknown }> };
    expect(persisted.records[0].snapshot).toBeNull();
  });

  it("expires retained snapshots after their bounded restore window", async () => {
    const executionScope = scope("tenant-a", "alice");
    const preview = createTrashPreview({
      resourceType: "openapi_connector",
      resourceId: "openapi-1",
      target: { id: "openapi-1" },
      effectSummary: "Move connector to trash.",
      now: "2026-09-07T10:00:00.000Z",
    });
    const created = await createTrashEntry({
      preview,
      displayLabel: "OpenAPI One",
      target: { id: "openapi-1" },
      snapshot: { connector: { id: "openapi-1" } },
      compensation: {
        kind: "exact_restore",
        handlerId: "trash.restore.openapi_connector",
        limitation: null,
      },
      restoreWindowMs: 60_000,
      now: "2026-09-07T10:00:01.000Z",
    }, { executionScope });
    const expired = await expireTrashItems({
      executionScope,
      now: "2026-09-07T10:01:02.000Z",
    });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      item: { trashId: created.item.trashId, state: "expired" },
      receipt: { action: "expire", afterState: "expired" },
    });
    await expect(getTrashItem(created.item.trashId, { executionScope }))
      .resolves.toMatchObject({ state: "expired" });
  });
});

async function createConnectorTrash(executionScope: ReturnType<typeof scope>) {
  const preview = createTrashPreview({
    resourceType: "mcp_connector",
    resourceId: "mcp-1",
    target: { id: "mcp-1", updatedAt: "2026-09-07T09:00:00.000Z" },
    effectSummary: "Move MCP One to trash.",
    now: "2026-09-07T10:00:00.000Z",
  });
  return createTrashEntry({
    preview,
    displayLabel: "MCP One",
    target: { id: "mcp-1", updatedAt: "2026-09-07T09:00:00.000Z" },
    snapshot: { connector: { id: "mcp-1" }, tools: [{ id: "tool-1" }] },
    compensation: {
      kind: "exact_restore",
      handlerId: "trash.restore.mcp_connector",
      limitation: null,
    },
    now: "2026-09-07T10:00:01.000Z",
  }, { executionScope });
}

function scope(tenantId: string, actorId: string) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: `trash:${tenantId}:${actorId}`,
    purpose: "Test reversible trash.",
  });
}
