import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

import { GET as GETTrash } from "@/app/api/trash/route";
import { GET as GETTrashItem } from "@/app/api/trash/[id]/route";
import {
  GET as GETRestore,
  POST as POSTRestore,
} from "@/app/api/trash/[id]/restore/route";
import {
  DELETE as DELETEPurge,
  GET as GETPurge,
} from "@/app/api/trash/[id]/purge/route";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { createAgentSkill } from "@/lib/skills/store";
import {
  captureRestorableResource,
  moveRestorableResourceToTrash,
} from "@/lib/trash/resources";
import { createTrashPreview } from "@/lib/trash/store";

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "trash-routes-"));
  process.env.OMNIAGENT_DATA_DIR = dataDirectory;
  delete process.env.DATABASE_URL;
  routeMocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "alice",
    role: "admin",
    source: "session",
  });
});

afterEach(async () => {
  delete process.env.OMNIAGENT_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("trash recovery routes", () => {
  it("lists metadata and completes an exact restore preview", async () => {
    const trashId = await trashSkill("Restore route Skill");
    const listResponse = await GETTrash(new Request("http://localhost/api/trash?state=retained"));
    const listBody = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listBody.items).toEqual([
      expect.objectContaining({ trashId, state: "retained" }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain("Instructions for");

    const itemResponse = await GETTrashItem(
      new Request(`http://localhost/api/trash/${encodeURIComponent(trashId)}`),
      routeContext(trashId),
    );
    const itemBody = await itemResponse.json();
    expect(itemBody).toMatchObject({
      item: { trashId },
      receipts: [{ action: "trash" }],
    });

    const previewResponse = await GETRestore(
      new Request(`http://localhost/api/trash/${encodeURIComponent(trashId)}/restore`),
      routeContext(trashId),
    );
    const previewBody = await previewResponse.json();
    expect(previewBody.preview).toMatchObject({ action: "restore", trashId });
    const restoreResponse = await POSTRestore(
      new Request(`http://localhost/api/trash/${encodeURIComponent(trashId)}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "restore-route" },
        body: JSON.stringify({ preview: previewBody.preview }),
      }),
      routeContext(trashId),
    );
    await expect(restoreResponse.json()).resolves.toMatchObject({
      trash: { trashId, state: "restored" },
      effectReceipt: { action: "restore", outcome: "applied" },
    });
  });

  it("requires a separate preview and returns a final permanent-deletion receipt", async () => {
    const trashId = await trashSkill("Purge route Skill");
    const previewResponse = await GETPurge(
      new Request(`http://localhost/api/trash/${encodeURIComponent(trashId)}/purge`),
      routeContext(trashId),
    );
    const previewBody = await previewResponse.json();
    expect(previewBody).toMatchObject({
      permanent: true,
      preview: { action: "purge", reversible: false },
    });
    const purgeResponse = await DELETEPurge(
      new Request(`http://localhost/api/trash/${encodeURIComponent(trashId)}/purge`, {
        method: "DELETE",
        headers: { "content-type": "application/json", "idempotency-key": "purge-route" },
        body: JSON.stringify({ preview: previewBody.preview }),
      }),
      routeContext(trashId),
    );
    await expect(purgeResponse.json()).resolves.toMatchObject({
      trash: { trashId, state: "purged" },
      finalDeletionReceipt: { action: "purge", outcome: "applied" },
    });
  });
});

async function trashSkill(name: string) {
  const executionScope = createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "alice",
    executingPrincipalType: "user",
    executingPrincipalId: "alice",
    correlationId: `trash-route:${name}`,
    purpose: "Prepare a route test trash item.",
  });
  const skill = await createAgentSkill({
    name,
    description: `Description for ${name}.`,
    instructions: `Instructions for ${name} with enough detail.`,
    category: "analysis",
    status: "active",
    toolIds: [],
    tags: [],
    knowledgeTags: [],
  }, { tenantId: "tenant-a", actorId: "alice" });
  const snapshot = await captureRestorableResource("agent_skill", skill.id, executionScope);
  const target = {
    id: skill.id,
    name: skill.name,
    slug: skill.slug,
    affectedAgents: [],
  };
  const moved = await moveRestorableResourceToTrash({
    preview: createTrashPreview({
      resourceType: "agent_skill",
      resourceId: skill.id,
      target,
      effectSummary: `Move ${name} to trash.`,
    }),
    displayLabel: name,
    target,
    snapshot: snapshot!,
    executionScope,
  });
  return moved.item.trashId;
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
