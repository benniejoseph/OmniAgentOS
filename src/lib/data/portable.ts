import { createHash, randomUUID } from "node:crypto";
import { listOAuthGrants } from "@/lib/connectors/oauth-store";
import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { saveMemories, listMemories } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { createProject, createProjectTasks, listProjectCollections, listProjects } from "@/lib/projects/store";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { listKnowledgeChunks, listKnowledgeDocuments } from "@/lib/rag/store";
import { appendThreadTurn, createThread, listThreads, listThreadTurns } from "@/lib/threads/store";
import { createTodayItem, listTodayItems, updateTodayItem } from "@/lib/today/store";
import { createAgentSkill, createCustomAgent, listAgentSkills, listCustomAgents } from "@/lib/skills/store";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export type PortableArchive = Awaited<ReturnType<typeof createPortableArchive>>;

export async function createPortableArchive(input: {
  tenantId: string;
  actorId: string;
  memoryAccessScope?: DatabaseMemoryAccessScope;
}) {
  const [documents, chunks, memories, threads, today, projects, connections, skills, agents] = await Promise.all([
    listKnowledgeDocuments(5_000, { tenantId: input.tenantId }),
    listKnowledgeChunks(50_000, { tenantId: input.tenantId }),
    listPortableMemories(input),
    listThreads(100, { tenantId: input.tenantId, actorId: input.actorId }),
    listTodayItems(250, { tenantId: input.tenantId, actorId: input.actorId }),
    listProjects(100, { tenantId: input.tenantId, actorId: input.actorId }),
    listOAuthGrants(input.tenantId, input.actorId),
    listAgentSkills({ tenantId: input.tenantId, actorId: input.actorId }, false),
    listCustomAgents({ tenantId: input.tenantId, actorId: input.actorId }),
  ]);
  const [threadTurns, projectCollections] = await Promise.all([
    Promise.all(threads.map(async (thread) => ({ thread, turns: await listThreadTurns(thread.id, { tenantId: input.tenantId, limit: 100 }) }))),
    listProjectCollections(projects.map((project) => project.id), { tenantId: input.tenantId }),
  ]);
  const chunksByDocument = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const list = chunksByDocument.get(chunk.documentId) || [];
    list.push(chunk); chunksByDocument.set(chunk.documentId, list);
  }
  return {
    format: "asael-portable-archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    owner: { actorId: input.actorId },
    knowledge: documents.map((document) => ({
      id: document.id,
      title: document.title,
      source: document.source,
      sourceType: document.sourceType,
      tags: document.tags,
      contentHash: document.contentHash,
      content: (chunksByDocument.get(document.id) || []).sort((left, right) => left.chunkIndex - right.chunkIndex).map((chunk) => chunk.content).join("\n\n"),
      updatedAt: document.updatedAt,
    })),
    memories: memories.map(portableMemory),
    threads: threadTurns.map(({ thread, turns }) => ({ title: thread.title, mode: thread.mode, turns: turns.map(({ role, content, createdAt }) => ({ role, content, createdAt })) })),
    today: today.map(portableOwnedRecord),
    projects: projects.map((project) => ({
      title: project.title,
      objective: project.objective,
      status: project.status,
      targetDate: project.targetDate,
      tasks: (projectCollections.tasksByProject.get(project.id) || []).map((task) => ({ title: task.title, detail: task.detail, priority: task.priority, agentId: task.agentId, origin: task.origin, dueAt: task.dueAt })),
    })),
    connections: connections.map((grant) => ({ provider: grant.provider, scopes: grant.scopes, status: grant.status, lastSyncedAt: grant.lastSyncedAt, syncedItems: grant.syncedItems })),
    skills: skills.map(({ id, name, description, instructions, category, status, toolIds, tags, knowledgeTags }) => ({ id, name, description, instructions, category, status, toolIds, tags, knowledgeTags })),
    agents: agents.map(({ id, name, role, description, instructions, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds }) => ({ id, name, role, description, instructions, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds })),
  };
}

export async function restorePortableArchive(archive: unknown, input: {
  tenantId: string;
  actorId: string;
  privateMemoryOwnerActorId?: string;
  memoryAccessScope?: DatabaseMemoryAccessScope;
  memoryExecutionScope?: ExecutionScope;
  abortSignal?: AbortSignal;
}) {
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
    executionScope: privateMemoryBinding
      ? input.memoryExecutionScope
      : undefined,
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
    const project = await createProject({ tenantId: input.tenantId, actorId: input.actorId, title: item.title, objective: item.objective, status: item.status, targetDate: item.targetDate });
    await createProjectTasks(project.id, item.tasks.slice(0, 20), { tenantId: input.tenantId });
  }
  return { knowledge, memories: memoryInputs.length, threads: data.threads.length, turns, today: data.today.length, projects: data.projects.length, skills: data.skills.length, agents: data.agents.length };
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
  const legacy = await listMemories({
    tenantId: input.tenantId,
    limit: 20_000,
    includeInactive: true,
  });
  const scoped = input.memoryAccessScope
    ? await listMemories({
        tenantId: input.tenantId,
        limit: 20_000,
        includeInactive: true,
        accessScope: input.memoryAccessScope,
      })
    : [];
  return [...new Map(
    [...legacy, ...scoped].map((memory) => [memory.id, memory] as const),
  ).values()]
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
function portableMemory(memory: MemoryRecord) { const copy = { ...memory } as Partial<MemoryRecord>; delete copy.embedding; delete copy.tenantId; return copy; }
function portableOwnedRecord<T extends { tenantId: string; actorId: string }>(item: T) { const copy: Partial<T> = { ...item }; delete copy.tenantId; delete copy.actorId; return copy; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function number(value: unknown, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : fallback; }
function digest(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 40); }
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
