import { createHash, randomUUID } from "node:crypto";
import {
  getCaptureAssetContent,
  listCaptureAssets,
  saveCaptureAsset,
} from "@/lib/capture/assets";
import { listOAuthGrants } from "@/lib/connectors/oauth-store";
import {
  buildPortableArchiveV2,
  buildPortableRestoreReceiptV1,
  createPortableAssetEncryption,
  decryptPortableAssetBytes,
  encryptPortableAssetBytes,
  portableJsonSha256,
  portableTextSha256,
  verifyPortableArchiveV2,
  type PortableArchiveDataV2,
  type PortableArchiveExclusion,
  type PortableArchiveSectionName,
} from "@/lib/data/portable-contract";
import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { saveMemories, listMemories } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { createProject, createProjectTasks, listProjectCollections, listProjects } from "@/lib/projects/store";
import { projectMutationSha256 } from "@/lib/projects/events";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { listActorOwnedKnowledgeForPortableArchive } from "@/lib/rag/store";
import { appendThreadTurn, createThread, listThreads, listThreadTurns } from "@/lib/threads/store";
import { createTodayItem, listTodayItems, updateTodayItem } from "@/lib/today/store";
import { createAgentSkill, createCustomAgent, listAgentSkills, listCustomAgents } from "@/lib/skills/store";
import {
  createExecutionScope,
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export type PortableArchive = Awaited<ReturnType<typeof createPortableArchive>>;

const MAX_PORTABLE_ASSET_COUNT = 25;
const MAX_PORTABLE_ASSET_BYTES = 2 * 1024 * 1024;

export async function createPortableArchive(input: {
  tenantId: string;
  actorId: string;
  memoryAccessScope?: DatabaseMemoryAccessScope;
  includeAssets?: boolean;
  assetPassphrase?: string;
}) {
  const [knowledgeRecords, memories, threads, today, projects, connections, skills, agents, assets] = await Promise.all([
    listActorOwnedKnowledgeForPortableArchive({
      tenantId: input.tenantId,
      actorId: input.actorId,
      documentLimit: 5_000,
      chunkLimit: 50_000,
    }),
    listPortableMemories(input),
    listThreads(100, { tenantId: input.tenantId, actorId: input.actorId }),
    listTodayItems(250, { tenantId: input.tenantId, actorId: input.actorId }),
    listProjects(100, { tenantId: input.tenantId, actorId: input.actorId }),
    listOAuthGrants(input.tenantId, input.actorId),
    listAgentSkills({ tenantId: input.tenantId, actorId: input.actorId }, false),
    listCustomAgents({ tenantId: input.tenantId, actorId: input.actorId }),
    listCaptureAssets({ tenantId: input.tenantId, actorId: input.actorId }, 100),
  ]);
  const [threadTurns, projectCollections] = await Promise.all([
    Promise.all(threads.map(async (thread) => ({ thread, turns: await listThreadTurns(thread.id, { tenantId: input.tenantId, limit: 100 }) }))),
    listProjectCollections(projects.map((project) => project.id), { tenantId: input.tenantId }),
  ]);
  const chunksByDocument = new Map<string, typeof knowledgeRecords.chunks>();
  for (const chunk of knowledgeRecords.chunks) {
    const list = chunksByDocument.get(chunk.documentId) || [];
    list.push(chunk); chunksByDocument.set(chunk.documentId, list);
  }
  const includedMemories = memories.filter((memory) => memory.claimStatus !== "forgotten");
  const assetExport = await exportPortableAssets(assets, input);
  const data: PortableArchiveDataV2 = {
    knowledge: knowledgeRecords.documents.map((document) => {
      const content = (chunksByDocument.get(document.id) || [])
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .map((chunk) => chunk.content)
        .join("\n\n");
      return {
        sourceId: document.id,
        title: document.title,
        source: document.source,
        sourceType: document.sourceType,
        tags: document.tags,
        content,
        contentSha256: portableTextSha256(content),
        sourceContentSha256: sha256OrNull(document.contentHash),
        sourceRevisionIdSha256: document.sourceRevisionId
          ? portableTextSha256(document.sourceRevisionId)
          : null,
        updatedAt: dateOrNull(document.updatedAt),
      };
    }),
    memories: includedMemories.map(portableMemoryV2),
    threads: threadTurns.map(({ thread, turns }) => ({
      sourceIdSha256: portableTextSha256(thread.id),
      title: thread.title,
      mode: thread.mode,
      turns: turns.map(({ role, content, createdAt }, index) => ({
        index,
        role,
        content,
        contentSha256: portableTextSha256(content),
        createdAt: dateOrNull(createdAt),
      })),
    })),
    today: today.map((item) => ({
      sourceIdSha256: portableTextSha256(item.id),
      title: item.title,
      kind: item.kind,
      priority: item.priority,
      status: item.status,
      dueAt: dateOrNull(item.dueAt),
    })),
    projects: projects.map((project) => ({
      sourceIdSha256: portableTextSha256(project.id),
      title: project.title,
      objective: project.objective,
      status: project.status,
      targetDate: dateOrNull(project.targetDate),
      tasks: (projectCollections.tasksByProject.get(project.id) || []).slice(0, 20).map((task) => ({
        sourceIdSha256: portableTextSha256(task.id),
        title: task.title,
        detail: task.detail,
        priority: task.priority,
        agentId: task.agentId,
        origin: task.origin,
        dueAt: dateOrNull(task.dueAt),
      })),
    })),
    connections: connections.map((grant) => ({
      provider: grant.provider,
      scopes: [...new Set(grant.scopes)].sort(),
      configurationSha256: portableJsonSha256({
        provider: grant.provider,
        scopes: [...new Set(grant.scopes)].sort(),
      }),
      reauthorizationRequired: true,
    })),
    skills: skills.map(({ id, name, description, instructions, category, status, toolIds, tags, knowledgeTags }) => ({ sourceId: id, name, description, instructions, category, status, toolIds, tags, knowledgeTags })),
    agents: agents.map(({ id, name, role, description, instructions, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds }) => ({ sourceId: id, name, role, description, instructions, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds })),
    assets: assetExport.assets,
  };
  const exclusions: PortableArchiveExclusion[] = [
    { category: "secrets", reason: "always_excluded", count: null },
    { category: "connector_credentials", reason: "reauthorization_required", count: connections.length },
    { category: "embeddings", reason: "regenerated_after_restore", count: knowledgeRecords.chunks.length + includedMemories.length },
    { category: "memories", reason: "records_without_exact_actor_scope_excluded", count: null },
    { category: "provider_cursors", reason: "reauthorization_required", count: connections.length },
    { category: "operational_audit_data", reason: "not_portable_user_content", count: null },
    ...assetExport.exclusions,
  ];
  const excludedCounts: Partial<Record<PortableArchiveSectionName, number | null>> = {
    knowledge: knowledgeRecords.excludedDocumentCount,
    memories: null,
    threads: threads.length === 100 ? null : 0,
    today: today.length === 250 ? null : 0,
    projects: projects.length === 100 ? null : 0,
    connections: 0,
    skills: skills.length === 250 ? null : 0,
    agents: agents.length === 100 ? null : 0,
    assets: assetExport.excludedCount,
  };
  if (memories.length === 20_000) exclusions.push({ category: "memories", reason: "section_limit_reached", count: null });
  if (threads.length === 100) exclusions.push({ category: "threads", reason: "section_limit_reached", count: null });
  if (threadTurns.some(({ turns }) => turns.length === 100)) exclusions.push({ category: "thread_turns", reason: "section_limit_reached", count: null });
  if (today.length === 250) exclusions.push({ category: "today", reason: "section_limit_reached", count: null });
  if (projects.length === 100) exclusions.push({ category: "projects", reason: "section_limit_reached", count: null });
  if (skills.length === 250) exclusions.push({ category: "skills", reason: "section_limit_reached", count: null });
  if (agents.length === 100) exclusions.push({ category: "agents", reason: "section_limit_reached", count: null });
  return buildPortableArchiveV2({
    exportedAt: new Date().toISOString(),
    sourceOwnerActorId: input.actorId,
    sourceTenantId: input.tenantId,
    data,
    assetEncryption: assetExport.encryption,
    exclusions,
    excludedCounts,
  });
}

async function exportPortableAssets(
  assets: Awaited<ReturnType<typeof listCaptureAssets>>,
  input: {
    tenantId: string;
    actorId: string;
    includeAssets?: boolean;
    assetPassphrase?: string;
  },
) {
  const listingMayBeTruncated = assets.length === 100;
  if (!input.includeAssets) {
    return {
      assets: [] as PortableArchiveDataV2["assets"],
      encryption: null,
      excludedCount: listingMayBeTruncated ? null : assets.length,
      exclusions: assets.length || listingMayBeTruncated
        ? [{
            category: "assets",
            reason: "encrypted_assets_not_requested",
            count: listingMayBeTruncated ? null : assets.length,
          } satisfies PortableArchiveExclusion]
        : [],
    };
  }
  const passphrase = input.assetPassphrase || "";
  if (passphrase.normalize("NFKC").length < 12) {
    throw new Error("Encrypted asset export requires a passphrase of at least 12 characters.");
  }
  const encryption = createPortableAssetEncryption();
  const encrypted: PortableArchiveDataV2["assets"] = [];
  const exclusions = new Map<string, number>();
  let includedBytes = 0;
  for (const asset of assets) {
    if (!asset.manageable) {
      exclusions.set("owner_scope_unavailable", (exclusions.get("owner_scope_unavailable") || 0) + 1);
      continue;
    }
    if (encrypted.length >= MAX_PORTABLE_ASSET_COUNT) {
      exclusions.set("asset_count_limit", (exclusions.get("asset_count_limit") || 0) + 1);
      continue;
    }
    if (includedBytes + asset.byteCount > MAX_PORTABLE_ASSET_BYTES) {
      exclusions.set("archive_size_limit", (exclusions.get("archive_size_limit") || 0) + 1);
      continue;
    }
    try {
      const original = await getCaptureAssetContent(asset.id, {
        tenantId: input.tenantId,
        actorId: input.actorId,
      });
      encrypted.push(encryptPortableAssetBytes({
        metadata: {
          sourceIdSha256: portableTextSha256(asset.id),
          filename: asset.filename,
          mediaType: asset.mediaType,
          extension: asset.extension,
          byteCount: asset.byteCount,
          contentSha256: asset.contentSha256,
          tags: asset.tags,
          createdAt: dateOrNull(asset.createdAt),
        },
        bytes: original.bytes,
        passphrase,
        encryption,
      }));
      includedBytes += asset.byteCount;
    } catch {
      exclusions.set("asset_unavailable", (exclusions.get("asset_unavailable") || 0) + 1);
    }
  }
  if (listingMayBeTruncated) {
    exclusions.set("section_limit_reached", -1);
  }
  const knownExcludedCount = [...exclusions.values()]
    .filter((count) => count >= 0)
    .reduce((sum, count) => sum + count, 0);
  return {
    assets: encrypted,
    encryption: encrypted.length ? encryption : null,
    excludedCount: listingMayBeTruncated ? null : knownExcludedCount,
    exclusions: [...exclusions.entries()].map(([reason, count]) => ({
      category: "assets",
      reason,
      count: count < 0 ? null : count,
    } satisfies PortableArchiveExclusion)),
  };
}

function portableMemoryV2(memory: MemoryRecord): PortableArchiveDataV2["memories"][number] {
  return {
    sourceId: memory.id,
    title: memory.title,
    content: memory.content,
    contentSha256: portableTextSha256(memory.content),
    type: memory.type,
    tier: memory.tier,
    tierPolicyVersion: memory.tierPolicyVersion,
    formationReason: memory.formationReason,
    tags: memory.tags,
    scope: memory.scope,
    source: memory.source,
    importance: memory.importance,
    confidence: memory.confidence ?? 0.7,
    claimStatus: memory.claimStatus === "candidate" ||
        memory.claimStatus === "superseded" ||
        memory.claimStatus === "contradicted"
      ? memory.claimStatus
      : "active",
    assertedBy: memory.assertedBy || "import",
    evidenceRefs: memory.evidenceRefs || [],
    validFrom: dateOrNull(memory.validFrom),
    validTo: dateOrNull(memory.validTo),
    retentionExpiresAt: dateOrNull(memory.retentionExpiresAt),
    lastUsedAt: dateOrNull(memory.lastUsedAt),
    useCount: memory.useCount || 0,
    promotedFromTier: memory.promotedFromTier || null,
    promotedAt: dateOrNull(memory.promotedAt),
    supersedesId: memory.supersedesId || null,
    contradictionOfId: memory.contradictionOfId || null,
    createdAt: dateOrNull(memory.createdAt),
    updatedAt: dateOrNull(memory.updatedAt),
  };
}

type PortableRestoreInput = {
  tenantId: string;
  actorId: string;
  privateMemoryOwnerActorId?: string;
  memoryAccessScope?: DatabaseMemoryAccessScope;
  memoryExecutionScope?: ExecutionScope;
  abortSignal?: AbortSignal;
  assetPassphrase?: string;
};

export async function restorePortableArchive(
  archive: unknown,
  input: PortableRestoreInput,
) {
  const candidate = record(archive);
  if (candidate.format === "asael-portable-archive" && candidate.version === 2) {
    return restorePortableArchiveV2(archive, input);
  }
  return restorePortableArchiveV1(archive, input);
}

async function restorePortableArchiveV2(
  archive: unknown,
  input: PortableRestoreInput,
) {
  const verified = verifyPortableArchiveV2(archive);
  const decryptedAssets = verified.data.assets.map((asset) => {
    if (!verified.assetEncryption || !input.assetPassphrase) {
      throw new Error("This archive contains encrypted assets and requires its passphrase.");
    }
    return {
      asset,
      bytes: decryptPortableAssetBytes({
        asset,
        passphrase: input.assetPassphrase,
        encryption: verified.assetEncryption,
      }),
    };
  });
  input.abortSignal?.throwIfAborted();
  const sourceExecutionScope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: input.actorId,
    correlationId: `portable_restore_${verified.archiveSha256.slice(0, 48)}`,
    purpose: "portable.archive_v2.restore",
  });
  const privateMemoryBinding = input.privateMemoryOwnerActorId &&
      input.memoryAccessScope &&
      input.memoryExecutionScope
    ? buildUserPrivateMemoryAccessBindingV1({
        tenantId: input.tenantId,
        ownerActorId: input.privateMemoryOwnerActorId,
        originPurpose: "api.portable.restore",
      })
    : undefined;

  // Name collisions are checked before the first mutation so an incompatible
  // skill or agent cannot leave a partially restored archive behind.
  const [currentSkills, currentAgents] = await Promise.all([
    listAgentSkills({
      tenantId: input.tenantId,
      actorId: input.actorId,
    }, false),
    listCustomAgents({
      tenantId: input.tenantId,
      actorId: input.actorId,
    }),
  ]);
  const archivedSkillIds = new Set(
    verified.data.skills.map((skill) => skill.sourceId),
  );
  const preflightSkillIds = new Map<string, string>();
  for (const item of verified.data.skills) {
    const existing = currentSkills.find((candidate) => candidate.name === item.name);
    if (!existing) continue;
    if (!portableSkillMatches(existing, item)) {
      throw new Error(`A different Skill named ${item.name} already exists.`);
    }
    preflightSkillIds.set(item.sourceId, existing.id);
  }
  for (const item of verified.data.agents) {
    const existing = currentAgents.find((candidate) => candidate.name === item.name);
    if (!existing) continue;
    const preflightInput = portableAgentCreateInput(
      item,
      preflightSkillIds,
      archivedSkillIds,
    );
    if (!portableAgentMatches(existing, preflightInput)) {
      throw new Error(`A different Agent named ${item.name} already exists.`);
    }
  }

  let knowledge = 0;
  for (const item of verified.data.knowledge) {
    input.abortSignal?.throwIfAborted();
    await ingestTextDocument({
      idempotencyKey: `portable:v2:${verified.archiveSha256}:${portableTextSha256(item.sourceId)}`,
      tenantId: input.tenantId,
      title: item.title,
      content: item.content,
      source: `portable:archive:${verified.archiveSha256}:knowledge:${portableTextSha256(item.sourceId)}`,
      sourceType: item.sourceType,
      tags: [...new Set([...item.tags, "portable-restore"])],
      metadata: {
        portableArchiveSha256: verified.archiveSha256,
        portableSourceIdSha256: portableTextSha256(item.sourceId),
        originalSourceSha256: portableTextSha256(item.source),
      },
      abortSignal: input.abortSignal,
      usageScope: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        sourceStreamId: `portable:restore:${verified.archiveSha256}`,
        operation: "embedding",
        purpose: "portable.knowledge.restore",
        credentialSource: "deployment_environment",
      },
      sourceLineage: {
        executionScope: sourceExecutionScope,
        connectionId: "first_party.portable_restore",
        adapterId: "asael.portable_restore",
        adapterVersionId: "2",
        externalItemId: `${verified.archiveSha256}:${item.sourceId}`,
        providerRevisionId: item.contentSha256,
        sourceKind: portableSourceKind(item.sourceType),
        sourceUpdatedAt: item.updatedAt,
        capturedAt: item.updatedAt || verified.exportedAt,
        visibility: "user_private",
        sensitivity: "confidential",
        permissionGrantIds: ["first_party.portable_restore"],
        retentionPolicyId: "retention.portable.owner-controlled",
      },
    });
    knowledge += 1;
  }

  const restoredMemoryIds = new Map(
    verified.data.memories.map((memory) => [
      memory.sourceId,
      `portable_v2_${digest(`${input.tenantId}:${input.privateMemoryOwnerActorId || input.actorId}:${verified.archiveSha256}:${memory.sourceId}`)}`,
    ]),
  );
  const memoryInputs = verified.data.memories.map((memory) => ({
    tenantId: input.tenantId,
    id: restoredMemoryIds.get(memory.sourceId)!,
    title: memory.title,
    content: memory.content,
    type: memory.type,
    tier: memory.tier,
    formationReason: "portable_restore" as const,
    tags: [...new Set([...memory.tags, "portable-restore"])],
    scope: privateMemoryBinding ? "user" as const : memory.scope,
    source: `portable-restore:${verified.archiveSha256}`,
    importance: memory.importance,
    confidence: memory.confidence,
    claimStatus: memory.claimStatus,
    assertedBy: "import" as const,
    evidenceRefs: memory.evidenceRefs.map((reference) =>
      `portable-evidence:${portableTextSha256(reference)}`
    ),
    validFrom: memory.validFrom || undefined,
    validTo: memory.validTo || undefined,
    retentionExpiresAt: memory.retentionExpiresAt || undefined,
    promotedFromTier: memory.promotedFromTier || undefined,
    promotedAt: memory.promotedAt || undefined,
    supersedesId: memory.supersedesId
      ? restoredMemoryIds.get(memory.supersedesId)
      : undefined,
    contradictionOfId: memory.contradictionOfId
      ? restoredMemoryIds.get(memory.contradictionOfId)
      : undefined,
    embedding: undefined,
    accessBinding: privateMemoryBinding,
    databaseAccessScope: privateMemoryBinding
      ? input.memoryAccessScope
      : undefined,
    executionScope: input.memoryExecutionScope || deriveExecutionScope(
      sourceExecutionScope,
      { purpose: "portable.memory.restore" },
    ),
  }));
  if (memoryInputs.length) await saveMemories(memoryInputs);

  const existingThreads = await listThreads(100, {
    tenantId: input.tenantId,
    actorId: input.actorId,
  });
  const usedThreadIds = new Set<string>();
  let turns = 0;
  for (const archived of verified.data.threads) {
    input.abortSignal?.throwIfAborted();
    const existing = await findExistingPortableThread(
      archived,
      existingThreads,
      usedThreadIds,
      input.tenantId,
    );
    if (existing) {
      usedThreadIds.add(existing.id);
      turns += archived.turns.length;
      continue;
    }
    const thread = await createThread({
      tenantId: input.tenantId,
      actorId: input.actorId,
      title: archived.title,
      mode: archived.mode,
    });
    usedThreadIds.add(thread.id);
    existingThreads.push(thread);
    for (const turn of archived.turns) {
      await appendThreadTurn({
        tenantId: input.tenantId,
        threadId: thread.id,
        role: turn.role,
        content: turn.content,
      });
      turns += 1;
    }
  }

  const existingToday = await listTodayItems(250, {
    tenantId: input.tenantId,
    actorId: input.actorId,
  });
  const usedTodayIds = new Set<string>();
  for (const item of verified.data.today) {
    const existing = existingToday.find((candidate) =>
      !usedTodayIds.has(candidate.id) && portableTodayMatches(candidate, item)
    );
    if (existing) {
      usedTodayIds.add(existing.id);
      continue;
    }
    const created = await createTodayItem({
      tenantId: input.tenantId,
      actorId: input.actorId,
      title: item.title,
      kind: item.kind,
      priority: item.priority,
      dueAt: item.dueAt || undefined,
    });
    if (item.status === "done") {
      await updateTodayItem(created.id, { status: "done" }, {
        tenantId: input.tenantId,
        actorId: input.actorId,
      });
    }
    usedTodayIds.add(created.id);
    existingToday.push({ ...created, status: item.status });
  }

  const restoredSkillIds = new Map(preflightSkillIds);
  for (const item of verified.data.skills) {
    const existing = currentSkills.find((candidate) => candidate.name === item.name);
    if (existing) {
      if (!portableSkillMatches(existing, item)) {
        throw new Error(`A different Skill named ${item.name} already exists.`);
      }
      restoredSkillIds.set(item.sourceId, existing.id);
      continue;
    }
    const { sourceId: _sourceId, ...createInput } = item;
    void _sourceId;
    const restored = await createAgentSkill(createInput, {
      tenantId: input.tenantId,
      actorId: input.actorId,
    });
    currentSkills.push(restored);
    restoredSkillIds.set(item.sourceId, restored.id);
  }

  for (const item of verified.data.agents) {
    const createInput = portableAgentCreateInput(
      item,
      restoredSkillIds,
      archivedSkillIds,
    );
    const existing = currentAgents.find((candidate) => candidate.name === item.name);
    if (existing) {
      if (!portableAgentMatches(existing, createInput)) {
        throw new Error(`A different Agent named ${item.name} already exists.`);
      }
      continue;
    }
    currentAgents.push(await createCustomAgent(createInput, {
      tenantId: input.tenantId,
      actorId: input.actorId,
    }));
  }

  for (const item of verified.data.projects) {
    const projectRestoreKey = `portable-project:v2:${verified.archiveSha256}:${item.sourceIdSha256}`;
    const projectScope = deriveExecutionScope(sourceExecutionScope, {
      causationId: projectRestoreKey,
      purpose: "portable.project.restore",
    });
    const project = await createProject({
      tenantId: input.tenantId,
      actorId: input.actorId,
      title: item.title,
      objective: item.objective,
      status: item.status,
      targetDate: item.targetDate || undefined,
      mutation: {
        executionScope: projectScope,
        idempotencyKey: projectRestoreKey,
      },
    });
    await createProjectTasks(project.id, item.tasks.map((task) => ({
      title: task.title,
      detail: task.detail,
      priority: task.priority,
      agentId: task.agentId,
      origin: task.origin,
      dueAt: task.dueAt || undefined,
    })), {
      tenantId: input.tenantId,
      actorId: input.actorId,
      mutation: {
        executionScope: deriveExecutionScope(projectScope, {
          projectId: project.id,
          causationId: project.id,
          purpose: "portable.project_tasks.restore",
        }),
        idempotencyKey: `${projectRestoreKey}:tasks`,
      },
    });
  }

  for (const { asset, bytes } of decryptedAssets) {
    const assetScope = deriveExecutionScope(sourceExecutionScope, {
      causationId: `portable-asset:${asset.sourceIdSha256}`,
      purpose: "portable.asset.restore",
    });
    await saveCaptureAsset({
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionScope: assetScope,
      filename: asset.filename,
      mediaType: asset.mediaType,
      bytes,
      tags: [...new Set([...asset.tags, "portable-restore"])],
      metadata: {
        portableArchiveSha256: verified.archiveSha256,
        portableSourceIdSha256: asset.sourceIdSha256,
      },
    });
  }

  const restoredCounts = {
    knowledge,
    memories: memoryInputs.length,
    threads: verified.data.threads.length,
    turns,
    today: verified.data.today.length,
    projects: verified.data.projects.length,
    connections: 0,
    skills: verified.data.skills.length,
    agents: verified.data.agents.length,
    assets: decryptedAssets.length,
  };
  const verification = buildPortableRestoreReceiptV1({
    archive: verified,
    targetOwnerActorId: input.privateMemoryOwnerActorId || input.actorId,
    targetTenantId: input.tenantId,
    restoredCounts,
  });
  await appendScopedDomainEvent({
    id: `portable_restore_event_${portableJsonSha256({
      archiveSha256: verified.archiveSha256,
      targetTenantIdSha256: verification.targetTenantIdSha256,
      targetOwnerActorIdSha256: verification.targetOwnerActorIdSha256,
      receiptSha256: verification.receiptSha256,
    }).slice(0, 48)}`,
    streamId: `portable-restore:${verified.archiveSha256}`,
    type: "portable_archive.restore_completed",
    executionScope: sourceExecutionScope,
    payload: {
      schemaVersion: verification.schemaVersion,
      archiveSha256: verification.archiveSha256,
      manifestSha256: verification.manifestSha256,
      targetOwnerActorIdSha256: verification.targetOwnerActorIdSha256,
      targetTenantIdSha256: verification.targetTenantIdSha256,
      declaredCounts: verification.declaredCounts,
      restoredCounts: verification.restoredCounts,
      connectionsReauthorizationRequired:
        verification.connectionsReauthorizationRequired,
      ownershipRebound: verification.ownershipRebound,
      provenancePreserved: verification.provenancePreserved,
      archiveIntegrityVerified: verification.archiveIntegrityVerified,
      countsVerified: verification.countsVerified,
      hashesVerified: verification.hashesVerified,
      receiptSha256: verification.receiptSha256,
    },
  });
  return {
    ...restoredCounts,
    connectionsReauthorizationRequired:
      verification.connectionsReauthorizationRequired,
    verification,
  };
}

async function restorePortableArchiveV1(archive: unknown, input: PortableRestoreInput) {
  const data = asArchive(archive);
  const sourceExecutionScope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: input.actorId,
    correlationId: `portable_restore_${randomUUID()}`,
    purpose: "portable.knowledge.restore",
  });
  let knowledge = 0;
  for (const item of data.knowledge.slice(0, 5_000)) {
    input.abortSignal?.throwIfAborted();
    if (!item.content.trim()) continue;
    await ingestTextDocument({
      idempotencyKey: `portable:${item.id || digest(`${item.source}:${item.title}:${item.content}`)}`,
      tenantId: input.tenantId,
      title: item.title,
      content: item.content,
      source: item.source || "portable-restore",
      sourceType: item.sourceType,
      tags: [...new Set([...(item.tags || []), "portable-restore"])],
      abortSignal: input.abortSignal,
      usageScope: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        sourceStreamId: "portable:restore",
        operation: "embedding",
        purpose: "portable.knowledge.restore",
        credentialSource: "deployment_environment",
      },
      sourceLineage: {
        executionScope: sourceExecutionScope,
        connectionId: "first_party.portable_restore",
        adapterId: "asael.portable_restore",
        adapterVersionId: "1",
        externalItemId:
          item.id || digest(`${item.source}:${item.title}:${item.content}`),
        providerRevisionId: item.id || null,
        sourceKind: portableSourceKind(item.sourceType),
        sourceUpdatedAt: item.updatedAt,
        capturedAt: item.updatedAt || data.exportedAt,
      },
    });
    knowledge += 1;
  }
  const privateMemoryBinding = input.privateMemoryOwnerActorId &&
      input.memoryAccessScope &&
      input.memoryExecutionScope
    ? buildUserPrivateMemoryAccessBindingV1({
        tenantId: input.tenantId,
        ownerActorId: input.privateMemoryOwnerActorId,
        originPurpose: "api.portable.restore",
      })
    : undefined;
  const memoryInputs = data.memories.slice(0, 20_000).map((memory) => ({
    ...memory,
    tenantId: input.tenantId,
    id: memory.id || `portable_${digest(`${memory.title}:${memory.content}`)}`,
    source: memory.source || "portable-restore",
    scope: privateMemoryBinding ? "user" as const : memory.scope,
    embedding: undefined,
    accessBinding: privateMemoryBinding,
    databaseAccessScope: privateMemoryBinding
      ? input.memoryAccessScope
      : undefined,
    executionScope: input.memoryExecutionScope || deriveExecutionScope(
      sourceExecutionScope,
      { purpose: "portable.memory.restore" },
    ),
  }));
  if (memoryInputs.length) await saveMemories(memoryInputs);
  let turns = 0;
  for (const archived of data.threads.slice(0, 100)) {
    const thread = await createThread({ tenantId: input.tenantId, actorId: input.actorId, title: archived.title, mode: archived.mode });
    for (const turn of archived.turns.slice(0, 100)) {
      await appendThreadTurn({ tenantId: input.tenantId, threadId: thread.id, role: turn.role, content: turn.content });
      turns += 1;
    }
  }
  for (const item of data.today.slice(0, 250)) {
    const created = await createTodayItem({ tenantId: input.tenantId, actorId: input.actorId, title: item.title, kind: item.kind, priority: item.priority, dueAt: item.dueAt });
    if (item.status === "done") await updateTodayItem(created.id, { status: "done" }, { tenantId: input.tenantId, actorId: input.actorId });
  }
  const restoredSkillIds = new Map<string, string>();
  for (const item of data.skills.slice(0, 250)) {
    const restored = await createAgentSkill(item, { tenantId: input.tenantId, actorId: input.actorId });
    if (item.id) restoredSkillIds.set(item.id, restored.id);
  }
  for (const item of data.agents.slice(0, 100)) {
    await createCustomAgent({ name: item.name, role: item.role, description: item.description, instructions: item.instructions, status: item.status, accent: item.accent, modelPolicy: item.modelPolicy, autonomy: item.autonomy, approvalPolicy: item.approvalPolicy, memoryScope: item.memoryScope, skillIds: item.skillIds.map((skillId) => restoredSkillIds.get(skillId) || skillId), toolIds: item.toolIds }, { tenantId: input.tenantId, actorId: input.actorId });
  }
  for (const item of data.projects.slice(0, 100)) {
    const projectRestoreKey = `portable-project:${projectMutationSha256({
      title: item.title,
      objective: item.objective,
      status: item.status,
      targetDate: item.targetDate,
    })}`;
    const projectScope = deriveExecutionScope(sourceExecutionScope, {
      causationId: projectRestoreKey,
      purpose: "portable.project.restore",
    });
    const project = await createProject({
      tenantId: input.tenantId,
      actorId: input.actorId,
      title: item.title,
      objective: item.objective,
      status: item.status,
      targetDate: item.targetDate,
      mutation: {
        executionScope: projectScope,
        idempotencyKey: projectRestoreKey,
      },
    });
    await createProjectTasks(project.id, item.tasks.slice(0, 20), {
      tenantId: input.tenantId,
      actorId: input.actorId,
      mutation: {
        executionScope: deriveExecutionScope(projectScope, {
          projectId: project.id,
          causationId: project.id,
          purpose: "portable.project_tasks.restore",
        }),
        idempotencyKey: `${projectRestoreKey}:tasks`,
      },
    });
  }
  return { knowledge, memories: memoryInputs.length, threads: data.threads.length, turns, today: data.today.length, projects: data.projects.length, skills: data.skills.length, agents: data.agents.length };
}

async function findExistingPortableThread(
  archived: PortableArchiveDataV2["threads"][number],
  candidates: Awaited<ReturnType<typeof listThreads>>,
  usedIds: Set<string>,
  tenantId: string,
) {
  for (const candidate of candidates) {
    if (
      usedIds.has(candidate.id) ||
      candidate.title !== archived.title ||
      candidate.mode !== archived.mode
    ) {
      continue;
    }
    const turns = await listThreadTurns(candidate.id, { tenantId, limit: 100 });
    if (
      turns.length === archived.turns.length &&
      turns.every((turn, index) =>
        turn.role === archived.turns[index]?.role &&
        turn.content === archived.turns[index]?.content
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

function portableTodayMatches(
  current: Awaited<ReturnType<typeof listTodayItems>>[number],
  archived: PortableArchiveDataV2["today"][number],
) {
  return current.title === archived.title &&
    current.kind === archived.kind &&
    current.priority === archived.priority &&
    current.status === archived.status &&
    dateOrNull(current.dueAt) === archived.dueAt;
}

function portableSkillMatches(
  current: Awaited<ReturnType<typeof listAgentSkills>>[number],
  archived: PortableArchiveDataV2["skills"][number],
) {
  return portableJsonSha256({
    name: current.name,
    description: current.description,
    instructions: current.instructions,
    category: current.category,
    status: current.status,
    toolIds: current.toolIds,
    tags: current.tags,
    knowledgeTags: current.knowledgeTags,
  }) === portableJsonSha256({
    name: archived.name,
    description: archived.description,
    instructions: archived.instructions,
    category: archived.category,
    status: archived.status,
    toolIds: archived.toolIds,
    tags: archived.tags,
    knowledgeTags: archived.knowledgeTags,
  });
}

function portableAgentMatches(
  current: Awaited<ReturnType<typeof listCustomAgents>>[number],
  archived: Omit<PortableArchiveDataV2["agents"][number], "sourceId">,
) {
  return portableJsonSha256({
    name: current.name,
    role: current.role,
    description: current.description,
    instructions: current.instructions,
    status: current.status,
    accent: current.accent,
    modelPolicy: current.modelPolicy,
    autonomy: current.autonomy,
    approvalPolicy: current.approvalPolicy,
    memoryScope: current.memoryScope,
    skillIds: current.skillIds,
    toolIds: current.toolIds,
  }) === portableJsonSha256(archived);
}

function portableAgentCreateInput(
  item: PortableArchiveDataV2["agents"][number],
  restoredSkillIds: Map<string, string>,
  archivedSkillIds: Set<string>,
) {
  return {
    name: item.name,
    role: item.role,
    description: item.description,
    instructions: item.instructions,
    status: item.status,
    accent: item.accent,
    modelPolicy: item.modelPolicy,
    autonomy: item.autonomy,
    approvalPolicy: item.approvalPolicy,
    memoryScope: item.memoryScope,
    skillIds: item.skillIds.map((skillId) =>
      restoredSkillIds.get(skillId) ||
      (archivedSkillIds.has(skillId) ? `portable-unresolved:${skillId}` : skillId)
    ),
    toolIds: item.toolIds,
  };
}

function portableSourceKind(value: ReturnType<typeof sourceType>) {
  if (value === "url") return "webpage" as const;
  if (value === "file") return "file" as const;
  if (value === "api") return "record" as const;
  return "document" as const;
}

async function listPortableMemories(input: {
  tenantId: string;
  memoryAccessScope?: DatabaseMemoryAccessScope;
}) {
  if (!input.memoryAccessScope) return [];
  return (await listMemories({
    tenantId: input.tenantId,
    limit: 20_000,
    includeInactive: true,
    accessScope: input.memoryAccessScope,
  }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20_000);
}

function asArchive(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Archive must be a JSON object.");
  const archive = value as Record<string, unknown>;
  if (archive.format !== "asael-portable-archive" || archive.version !== 1) throw new Error("This is not a supported Asael portable archive.");
  const exportedAt = optionalDate(archive.exportedAt);
  if (!exportedAt) throw new Error("Portable archive is missing a valid export timestamp.");
  return {
    exportedAt,
    knowledge: array(archive.knowledge).map((item) => { const row = record(item); return { id: text(row.id, 200), title: text(row.title, 240) || "Restored knowledge", content: text(row.content, 900_000), source: text(row.source, 2_000), sourceType: sourceType(row.sourceType), tags: array(row.tags).map((tag) => text(tag, 100)).filter(Boolean).slice(0, 50), updatedAt: optionalDate(row.updatedAt) }; }),
    memories: array(archive.memories).map((item) => { const row = record(item); return { id: text(row.id, 200), title: text(row.title, 240) || "Restored memory", content: text(row.content, 200_000), type: memoryType(row.type), tags: array(row.tags).map((tag) => text(tag, 100)).filter(Boolean).slice(0, 50), scope: memoryScope(row.scope), source: text(row.source, 2_000), importance: number(row.importance, 0.5), confidence: number(row.confidence, 0.7), claimStatus: claimStatus(row.claimStatus), assertedBy: assertedBy(row.assertedBy), evidenceRefs: array(row.evidenceRefs).map((ref) => text(ref, 500)).filter(Boolean).slice(0, 100), validFrom: optionalDate(row.validFrom), validTo: optionalDate(row.validTo), supersedesId: text(row.supersedesId, 200) || undefined, contradictionOfId: text(row.contradictionOfId, 200) || undefined }; }),
    threads: array(archive.threads).map((item) => { const row = record(item); return { title: text(row.title, 90) || "Restored conversation", mode: mode(row.mode), turns: array(row.turns).map((turn) => { const value = record(turn); return { role: value.role === "assistant" ? "assistant" as const : "user" as const, content: text(value.content, 40_000) }; }).filter((turn) => turn.content) }; }),
    today: array(archive.today).map((item) => { const row = record(item); return { title: text(row.title, 280), kind: row.kind === "reminder" ? "reminder" as const : "task" as const, priority: priority(row.priority), status: row.status === "done" ? "done" as const : "open" as const, dueAt: optionalDate(row.dueAt) }; }).filter((item) => item.title),
    projects: array(archive.projects).map((item) => { const row = record(item); return { title: text(row.title, 180), objective: text(row.objective, 2_000), status: projectStatus(row.status), targetDate: optionalDate(row.targetDate), tasks: array(row.tasks).map((task) => { const value = record(task); return { title: text(value.title, 240), detail: text(value.detail, 1_000), priority: priority(value.priority), agentId: agentId(value.agentId), origin: value.origin === "agent" ? "agent" as const : "manual" as const, dueAt: optionalDate(value.dueAt) }; }).filter((task) => task.title) }; }).filter((item) => item.title && item.objective),
    skills: array(archive.skills).map((item) => { const row = record(item); return { id: identifier(row.id), name: text(row.name, 120), description: text(row.description, 500), instructions: text(row.instructions, 12_000), category: skillCategory(row.category), status: skillStatus(row.status), toolIds: identifiers(row.toolIds, 50), tags: identifiers(row.tags, 30), knowledgeTags: identifiers(row.knowledgeTags, 30) }; }).filter((item) => item.name && item.description && item.instructions.length >= 10),
    agents: array(archive.agents).map((item) => { const row = record(item); return { id: identifier(row.id), name: text(row.name, 120), role: text(row.role, 120), description: text(row.description, 700), instructions: text(row.instructions, 12_000), status: customAgentStatus(row.status), accent: agentAccent(row.accent), modelPolicy: agentModelPolicy(row.modelPolicy), autonomy: agentAutonomy(row.autonomy), approvalPolicy: agentApprovalPolicy(row.approvalPolicy), memoryScope: agentMemoryScope(row.memoryScope), skillIds: identifiers(row.skillIds, 30), toolIds: identifiers(row.toolIds, 50) }; }).filter((item) => item.name && item.role && item.description && item.instructions.length >= 10),
  };
}

function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function number(value: unknown, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : fallback; }
function digest(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 40); }
function dateOrNull(value: unknown) { return optionalDate(value) || null; }
function sha256OrNull(value: unknown) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function optionalDate(value: unknown) { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined; }
function sourceType(value: unknown) { return (["manual", "text", "file", "url", "api"] as const).find((item) => item === value) || "text"; }
function memoryType(value: unknown) { return (["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"] as const).find((item) => item === value) || "fact"; }
function memoryScope(value: unknown) { return (["user", "workspace", "project"] as const).find((item) => item === value) || "workspace"; }
function claimStatus(value: unknown) { return (["active", "candidate", "superseded", "contradicted"] as const).find((item) => item === value) || "active"; }
function assertedBy(value: unknown) { return (["user", "agent", "system", "import"] as const).find((item) => item === value) || "import"; }
function mode(value: unknown) { return (["orchestrate", "research", "execute", "learn"] as const).find((item) => item === value) || "orchestrate"; }
function priority(value: unknown) { return (["low", "medium", "high"] as const).find((item) => item === value) || "medium"; }
function projectStatus(value: unknown) { return (["draft", "active", "completed", "archived"] as const).find((item) => item === value) || "active"; }
function agentId(value: unknown) { return (["atlas", "scout", "forge", "sentinel", "mnemosyne"] as const).find((item) => item === value) || "atlas"; }
function identifier(value: unknown) { return text(value, 120).replace(/[^a-zA-Z0-9_.:-]/g, ""); }
function identifiers(value: unknown, max: number) { return [...new Set(array(value).map(identifier).filter(Boolean))].slice(0, max); }
function skillCategory(value: unknown) { return (["research", "creation", "analysis", "memory", "automation", "personal"] as const).find((item) => item === value) || "personal"; }
function skillStatus(value: unknown) { return value === "disabled" ? "disabled" as const : "active" as const; }
function customAgentStatus(value: unknown) { return (["ready", "learning", "paused"] as const).find((item) => item === value) || "ready"; }
function agentAccent(value: unknown) { return (["emerald", "blue", "amber", "violet", "rose"] as const).find((item) => item === value) || "emerald"; }
function agentModelPolicy(value: unknown) { return (["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"] as const).find((item) => item === value) || "auto"; }
function agentAutonomy(value: unknown) { return (["assist", "governed", "execute"] as const).find((item) => item === value) || "governed"; }
function agentApprovalPolicy(value: unknown) { return (["always", "risk_based", "read_only"] as const).find((item) => item === value) || "risk_based"; }
function agentMemoryScope(value: unknown) { return (["session", "project", "all"] as const).find((item) => item === value) || "all"; }
