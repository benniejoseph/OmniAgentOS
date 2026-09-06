import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { saveMemory } from "@/lib/memory/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { executeGovernedTool } from "@/lib/tools/executor";

vi.mock("@/lib/openai/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openai/client")>()),
  embedTexts: vi.fn().mockResolvedValue(undefined),
}));

const context: SecurityContext = {
  tenantId: "tenant-memory-conversation",
  actorId: "owner@example.com",
  role: "admin",
  source: "session",
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.com",
    sessionId: "session-memory-conversation",
    tenantName: "Memory conversation",
  },
};

describe("governed conversational memory tools", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-memory-conversation-"),
    );
    delete process.env.DATABASE_URL;
    delete process.env.OMNIAGENT_GRADUATED_AUTONOMY;
  });

  it("inspects, searches, and pins an owner-private memory with receipts", async () => {
    const memory = await privateMemory("memory-private-a");

    const inspected = await execute("memory.inspect", { id: memory.id }, "inspect");
    expect(inspected.record.status).toBe("executed");
    expect(inspected.result).toMatchObject({
      memory: {
        id: memory.id,
        access: {
          visibility: "user_private",
          owner: "current_user",
        },
      },
      receipt: {
        operation: "inspect",
        memoryId: memory.id,
        retrievalEligible: true,
      },
    });
    expect(inspected.result).not.toHaveProperty("memory.embedding");
    expect(inspected.result).not.toHaveProperty("memory.accessBinding");

    const searched = await execute(
      "memory.search",
      { query: "private launch preference", limit: 5 },
      "search",
    );
    expect(searched.result).toMatchObject({
      results: [{ record: { id: memory.id } }],
    });

    const pinned = await execute(
      "memory.lifecycle",
      { id: memory.id, action: "pin" },
      "pin",
    );
    expect(pinned.result).toMatchObject({
      memory: { id: memory.id, pinnedAt: expect.any(String) },
      receipt: {
        operation: "lifecycle_pin",
        historicalTruthChanged: false,
        permanentDeletion: false,
      },
    });
  });

  it("returns the exact irreversible impact digest before approval", async () => {
    const memory = await privateMemory("memory-private-delete");
    const preview = await execute(
      "memory.forget.preview",
      { id: memory.id },
      "forget-preview",
    );

    expect(preview.result).toMatchObject({
      preview: {
        state: "ready",
        memory: { id: memory.id },
        expectedReceiptManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      receipt: {
        operation: "forget_preview",
        memoryId: memory.id,
        irreversible: true,
      },
    });

    const digest = (preview.result as {
      preview: { expectedReceiptManifestSha256: string };
    }).preview.expectedReceiptManifestSha256;
    const pending = await executeGovernedTool({
      toolId: "memory.forget",
      input: {
        id: memory.id,
        expectedReceiptManifestSha256: digest,
      },
      dryRun: false,
      context,
      idempotencyKey: "memory-conversation:forget",
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: "memory-conversation:forget",
        purpose: "test.memory.conversation.forget",
      }),
    });
    expect(pending.record).toMatchObject({
      status: "approval_required",
      input: {
        id: memory.id,
        expectedReceiptManifestSha256: digest,
      },
    });
  });

  it("prepares a transcript-safe exact-owner export route", async () => {
    const exported = await execute("memory.export", {}, "export");
    expect(exported.result).toMatchObject({
      ready: true,
      downloadUrl: "/api/data/export",
      archiveVersion: 2,
      receipt: {
        scope: "exact_owner",
        contentCopiedIntoAgentTranscript: false,
      },
    });
    expect(JSON.stringify(exported.result)).not.toContain("session-memory-conversation");
  });
});

async function privateMemory(id: string) {
  const access = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "test.memory.conversation.write",
    correlationId: `seed:${id}`,
  });
  if (!access) throw new Error("Test memory access was not created.");
  return saveMemory({
    id,
    tenantId: context.tenantId,
    type: "preference",
    tier: "preference",
    formationReason: "explicit_user_request",
    title: "Private launch preference",
    content: "Keep launch notes concise and private.",
    tags: ["launch", "private"],
    scope: "user",
    source: "test-user-assertion",
    importance: 0.9,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "user",
    accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: context.tenantId,
      ownerActorId: access.actorBinding.canonicalActorId,
      originPurpose: "test.memory.conversation.write",
    }),
    databaseAccessScope: access.databaseAccessScope,
    executionScope: access.executionScope,
  });
}

function execute(
  toolId: string,
  input: Record<string, unknown>,
  suffix: string,
) {
  const correlationId = `memory-conversation:${suffix}`;
  return executeGovernedTool({
    toolId,
    input,
    dryRun: false,
    context,
    idempotencyKey: correlationId,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId,
      purpose: `test.${toolId}`,
    }),
  });
}
