import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPortableArchiveV2,
  portableTextSha256,
  type PortableArchiveDataV2,
} from "@/lib/data/portable-contract";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  createAgent: vi.fn(),
  createProject: vi.fn(),
  createProjectTasks: vi.fn(),
  createSkill: vi.fn(),
  createThread: vi.fn(),
  createToday: vi.fn(),
  getAsset: vi.fn(),
  ingest: vi.fn(),
  listAgents: vi.fn(),
  listAssets: vi.fn(),
  listConnections: vi.fn(),
  listKnowledge: vi.fn(),
  listMemories: vi.fn(),
  listProjectCollections: vi.fn(),
  listProjects: vi.fn(),
  listSkills: vi.fn(),
  listThreads: vi.fn(),
  listThreadTurns: vi.fn(),
  listToday: vi.fn(),
  saveAsset: vi.fn(),
  saveMemories: vi.fn(),
  updateToday: vi.fn(),
}));

vi.mock("@/lib/capture/assets", () => ({
  getCaptureAssetContent: mocks.getAsset,
  listCaptureAssets: mocks.listAssets,
  saveCaptureAsset: mocks.saveAsset,
}));
vi.mock("@/lib/connectors/oauth-store", () => ({ listOAuthGrants: mocks.listConnections }));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.appendEvent }));
vi.mock("@/lib/memory/store", () => ({
  listMemories: mocks.listMemories,
  saveMemories: mocks.saveMemories,
}));
vi.mock("@/lib/projects/store", () => ({
  createProject: mocks.createProject,
  createProjectTasks: mocks.createProjectTasks,
  listProjectCollections: mocks.listProjectCollections,
  listProjects: mocks.listProjects,
}));
vi.mock("@/lib/rag/retriever", () => ({ ingestTextDocument: mocks.ingest }));
vi.mock("@/lib/rag/store", () => ({
  listActorOwnedKnowledgeForPortableArchive: mocks.listKnowledge,
}));
vi.mock("@/lib/skills/store", () => ({
  createAgentSkill: mocks.createSkill,
  createCustomAgent: mocks.createAgent,
  listAgentSkills: mocks.listSkills,
  listCustomAgents: mocks.listAgents,
}));
vi.mock("@/lib/threads/store", () => ({
  appendThreadTurn: vi.fn(),
  createThread: mocks.createThread,
  listThreads: mocks.listThreads,
  listThreadTurns: mocks.listThreadTurns,
}));
vi.mock("@/lib/today/store", () => ({
  createTodayItem: mocks.createToday,
  listTodayItems: mocks.listToday,
  updateTodayItem: mocks.updateToday,
}));

import { createPortableArchive, restorePortableArchive } from "@/lib/data/portable";

function emptyData(): PortableArchiveDataV2 {
  return {
    knowledge: [], memories: [], threads: [], today: [], projects: [],
    connections: [], skills: [], agents: [], assets: [],
  };
}

function emptyArchive(data = emptyData()) {
  return buildPortableArchiveV2({
    exportedAt: "2026-09-06T10:00:00.000Z",
    sourceOwnerActorId: "source-owner",
    sourceTenantId: "source-tenant",
    data,
  });
}

describe("portable archive service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listKnowledge.mockResolvedValue({
      documents: [], chunks: [], totalDocumentCount: 0, excludedDocumentCount: 0,
    });
    mocks.listMemories.mockResolvedValue([]);
    mocks.listThreads.mockResolvedValue([]);
    mocks.listThreadTurns.mockResolvedValue([]);
    mocks.listToday.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([]);
    mocks.listProjectCollections.mockResolvedValue({ tasksByProject: new Map() });
    mocks.listConnections.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue([]);
    mocks.listAssets.mockResolvedValue([]);
    mocks.appendEvent.mockResolvedValue({ id: "event-a" });
  });

  it("exports only the exact-owner knowledge projection and reauthorization-safe connector metadata", async () => {
    mocks.listKnowledge.mockResolvedValue({
      documents: [{
        id: "knowledge-a",
        title: "Owned evidence",
        source: "drive://document-a",
        sourceType: "api",
        tags: ["owned"],
        contentHash: portableTextSha256("Owned content"),
        sourceRevisionId: "revision-a",
        updatedAt: "2026-09-06T09:00:00.000Z",
      }],
      chunks: [{ documentId: "knowledge-a", chunkIndex: 0, content: "Owned content" }],
      totalDocumentCount: 2,
      excludedDocumentCount: 1,
    });
    mocks.listConnections.mockResolvedValue([{
      provider: "google",
      scopes: ["calendar.read", "calendar.read"],
      accessToken: "must-not-export",
      sealedRefreshToken: "must-not-export",
    }]);

    const archive = await createPortableArchive({
      tenantId: "tenant-a",
      actorId: "owner-a",
    });
    const serialized = JSON.stringify(archive);

    expect(mocks.listKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "owner-a",
    }));
    expect(archive.data.knowledge).toHaveLength(1);
    expect(archive.manifest.sections.knowledge.excludedCount).toBe(1);
    expect(archive.data.connections).toEqual([expect.objectContaining({
      provider: "google",
      scopes: ["calendar.read"],
      reauthorizationRequired: true,
    })]);
    expect(archive.manifest.connectorCredentialsExcluded).toBe(true);
    expect(archive.manifest.sections.memories.excludedCount).toBeNull();
    expect(archive.manifest.exclusions).toContainEqual(expect.objectContaining({
      category: "memories",
      reason: "records_without_exact_actor_scope_excluded",
    }));
    expect(mocks.listMemories).not.toHaveBeenCalled();
    expect(serialized).not.toContain("must-not-export");
    expect(serialized).not.toContain("sealedRefreshToken");
  });

  it("verifies an archive before mutation and emits a hash-bound restore receipt", async () => {
    const data = emptyData();
    data.today.push({
      sourceIdSha256: portableTextSha256("today-a"),
      title: "Restored task",
      kind: "task",
      priority: "high",
      status: "open",
      dueAt: null,
    });
    mocks.createToday.mockResolvedValue({
      id: "restored-today-a",
      title: "Restored task",
      kind: "task",
      priority: "high",
      status: "open",
      dueAt: undefined,
    });
    const archive = emptyArchive(data);
    const restored = await restorePortableArchive(archive, {
      tenantId: "target-tenant",
      actorId: "target-owner",
    });

    expect(restored).toMatchObject({
      verification: {
        archiveSha256: archive.archiveSha256,
        targetOwnerActorIdSha256: portableTextSha256("target-owner"),
        ownershipRebound: true,
        provenancePreserved: true,
        archiveIntegrityVerified: true,
        countsVerified: true,
        hashesVerified: true,
        restoredCounts: { today: 1 },
      },
    });
    expect(mocks.createToday).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "target-tenant",
      actorId: "target-owner",
      title: "Restored task",
    }));
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "portable_archive.restore_completed",
      payload: expect.objectContaining({ archiveSha256: archive.archiveSha256 }),
    }));

    const tampered = structuredClone(archive);
    tampered.manifest.sections.knowledge.includedCount = 1;
    await expect(restorePortableArchive(tampered, {
      tenantId: "target-tenant",
      actorId: "target-owner",
    })).rejects.toThrow(/failed manifest or content verification/i);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("rejects incompatible skill collisions before restoring knowledge", async () => {
    const data = emptyData();
    data.knowledge.push({
      sourceId: "knowledge-a",
      title: "Portable knowledge",
      content: "content",
      contentSha256: portableTextSha256("content"),
      source: "manual",
      sourceType: "manual",
      tags: [],
      sourceContentSha256: null,
      sourceRevisionIdSha256: null,
      updatedAt: null,
    });
    data.skills.push({
      sourceId: "skill-a",
      name: "Existing skill",
      description: "Portable description",
      instructions: "Portable instructions",
      category: "analysis",
      status: "active",
      toolIds: [],
      tags: [],
      knowledgeTags: [],
    });
    mocks.listSkills.mockResolvedValue([{
      id: "current-skill",
      name: "Existing skill",
      description: "Different description",
      instructions: "Different instructions",
      category: "analysis",
      status: "active",
      toolIds: [],
      tags: [],
      knowledgeTags: [],
    }]);

    await expect(restorePortableArchive(emptyArchive(data), {
      tenantId: "target-tenant",
      actorId: "target-owner",
    })).rejects.toThrow(/different Skill/i);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.saveMemories).not.toHaveBeenCalled();
  });
});
