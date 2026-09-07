import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const CONVERSATION_CANVAS_VERSION =
  "p11.3-conversation-canvas:1" as const;

export type ConversationCanvasThreadSource = Readonly<{
  id: string;
  title: string;
  mode: string;
  projectId?: string;
  updatedAt: string;
}>;

export type ConversationCanvasRunSource = Readonly<{
  id: string;
  threadId: string;
  mode: string;
  status: string;
  agentId: string;
  startedAt: string;
  completedAt?: string;
  contextGrantCount: number | null;
}>;

export type ConversationCanvasForkSource = Readonly<{
  forkId: string;
  sourceRunId: string;
  targetRunId: string;
  checkpointId: string;
  checkpointSequence: number;
  boundaryKind: string;
  createdAt: string;
}>;

export type ConversationCanvasDelegationSource = Readonly<{
  taskId: string;
  parentExecutionId: string;
  parentDelegationId: string | null;
  delegationId: string;
  delegateAgentId: string;
  delegateDefinitionVersion: number;
  state: string;
  lifecycleRevision: number;
  updatedAt: string;
}>;

export type ConversationCanvasProjectSource = Readonly<{
  id: string;
  title: string;
  status: string;
  artifactCount: number;
  updatedAt: string;
}>;

export type ConversationCanvasProjectArtifactSource = Readonly<{
  id: string;
  projectId: string;
  title: string;
  status: string;
  agentId: string;
  updatedAt: string;
}>;

export type ConversationCanvasSharedArtifactSource = Readonly<{
  artifactId: string;
  artifactSha256: string;
  missionId: string;
  parentExecutionId: string;
  senderTaskId: string;
  recipientTaskIds: readonly string[];
  kind: string;
  title: string;
  createdAt: string;
}>;

export type ConversationCanvasSource = Readonly<{
  threads: readonly ConversationCanvasThreadSource[];
  runs: readonly ConversationCanvasRunSource[];
  forks: readonly ConversationCanvasForkSource[];
  delegations: readonly ConversationCanvasDelegationSource[];
  projects: readonly ConversationCanvasProjectSource[];
  projectArtifacts: readonly ConversationCanvasProjectArtifactSource[];
  sharedArtifacts: readonly ConversationCanvasSharedArtifactSource[];
  truncated: Readonly<{
    runs: boolean;
    forks: boolean;
    delegations: boolean;
    sharedArtifacts: boolean;
  }>;
}>;

export type ConversationCanvasNodeKind =
  | "conversation"
  | "run"
  | "project"
  | "delegation"
  | "artifact";

export type ConversationCanvasEdgeKind =
  | "conversation_run"
  | "run_fork"
  | "conversation_project"
  | "project_artifact"
  | "run_delegation"
  | "delegation_parent"
  | "delegation_artifact_produced"
  | "delegation_artifact_shared";

export type ConversationCanvasNode = Readonly<{
  id: string;
  kind: ConversationCanvasNodeKind;
  entityId: string;
  title: string;
  detail: string;
  status: string;
  occurredAt: string;
  threadId: string | null;
  runId: string | null;
  projectId: string | null;
  contextAccess: Readonly<{
    state: "granted" | "none" | "not_established";
    grantCount: number | null;
    detail: string;
  }>;
}>;

export type ConversationCanvasEdge = Readonly<{
  id: string;
  kind: ConversationCanvasEdgeKind;
  from: string;
  to: string;
  label: string;
  authority: string;
  relationshipId: string;
  contextAccess: Readonly<{
    state: "not_implied";
    detail: string;
  }>;
}>;

export type ConversationCanvasProjection = Readonly<{
  version: typeof CONVERSATION_CANVAS_VERSION;
  generatedAt: string;
  digest: string;
  nodes: readonly ConversationCanvasNode[];
  edges: readonly ConversationCanvasEdge[];
  counts: Readonly<Record<ConversationCanvasNodeKind, number>>;
  memoryBoundary: Readonly<{
    mode: "explicit_grants_only";
    grantedRunCount: number;
    detail: string;
  }>;
  truncated: ConversationCanvasSource["truncated"];
}>;

export function buildConversationCanvasProjection(input: {
  source: ConversationCanvasSource;
  generatedAt?: string;
}): ConversationCanvasProjection {
  const generatedAt = canonicalTimestamp(input.generatedAt || new Date().toISOString());
  const nodes = new Map<string, ConversationCanvasNode>();
  const edges = new Map<string, ConversationCanvasEdge>();
  const threadsById = new Map(input.source.threads.map((thread) => [thread.id, thread]));
  const runsById = new Map(input.source.runs.map((run) => [run.id, run]));
  const projectsById = new Map(input.source.projects.map((project) => [project.id, project]));
  const delegationsById = new Map(
    input.source.delegations.map((delegation) => [delegation.delegationId, delegation]),
  );

  for (const thread of input.source.threads) {
    addNode(nodes, {
      id: nodeId("conversation", thread.id),
      kind: "conversation",
      entityId: thread.id,
      title: safeText(thread.title, 200, "Conversation"),
      detail: `${modeLabel(thread.mode)} conversation`,
      status: "available",
      occurredAt: canonicalTimestamp(thread.updatedAt),
      threadId: thread.id,
      runId: null,
      projectId: thread.projectId || null,
      contextAccess: notEstablishedContext(
        "A conversation relationship does not grant shared memory.",
      ),
    });
  }

  for (const run of input.source.runs) {
    if (!threadsById.has(run.threadId)) continue;
    addNode(nodes, {
      id: nodeId("run", run.id),
      kind: "run",
      entityId: run.id,
      title: `${agentLabel(run.agentId)} run`,
      detail: `${modeLabel(run.mode)} · ${statusLabel(run.status)}`,
      status: safeStatus(run.status),
      occurredAt: canonicalTimestamp(run.completedAt || run.startedAt),
      threadId: run.threadId,
      runId: run.id,
      projectId: threadsById.get(run.threadId)?.projectId || null,
      contextAccess: runContextAccess(run.contextGrantCount),
    });
    addEdge(edges, {
      kind: "conversation_run",
      from: nodeId("conversation", run.threadId),
      to: nodeId("run", run.id),
      label: "executed as",
      authority: "agent_run.thread_id",
      relationshipId: run.id,
    });
  }

  for (const fork of input.source.forks) {
    if (!runsById.has(fork.sourceRunId) || !runsById.has(fork.targetRunId)) continue;
    addEdge(edges, {
      kind: "run_fork",
      from: nodeId("run", fork.sourceRunId),
      to: nodeId("run", fork.targetRunId),
      label: `forked at ${safeText(fork.boundaryKind, 40, "checkpoint")}`,
      authority: "run_fork_lineage",
      relationshipId: fork.forkId,
    });
  }

  for (const thread of input.source.threads) {
    if (!thread.projectId || !projectsById.has(thread.projectId)) continue;
    const project = projectsById.get(thread.projectId)!;
    if (!nodes.has(nodeId("project", project.id))) {
      addNode(nodes, {
        id: nodeId("project", project.id),
        kind: "project",
        entityId: project.id,
        title: safeText(project.title, 200, "Project"),
        detail: `${project.artifactCount} artifact${project.artifactCount === 1 ? "" : "s"}`,
        status: safeStatus(project.status),
        occurredAt: canonicalTimestamp(project.updatedAt),
        threadId: null,
        runId: null,
        projectId: project.id,
        contextAccess: notEstablishedContext(
          "Project membership and project-memory grants are separate authorities.",
        ),
      });
    }
    addEdge(edges, {
      kind: "conversation_project",
      from: nodeId("conversation", thread.id),
      to: nodeId("project", project.id),
      label: "bound project",
      authority: "thread.project_id",
      relationshipId: `thread-project:${canonicalJsonSha256({ threadId: thread.id, projectId: project.id })}`,
    });
  }

  for (const artifact of input.source.projectArtifacts) {
    if (!projectsById.has(artifact.projectId) || !nodes.has(nodeId("project", artifact.projectId))) continue;
    addNode(nodes, {
      id: nodeId("artifact", artifact.id),
      kind: "artifact",
      entityId: artifact.id,
      title: safeText(artifact.title, 200, "Project artifact"),
      detail: `${agentLabel(artifact.agentId)} · project artifact`,
      status: safeStatus(artifact.status),
      occurredAt: canonicalTimestamp(artifact.updatedAt),
      threadId: null,
      runId: null,
      projectId: artifact.projectId,
      contextAccess: notEstablishedContext(
        "Artifact visibility does not make it agent memory.",
      ),
    });
    addEdge(edges, {
      kind: "project_artifact",
      from: nodeId("project", artifact.projectId),
      to: nodeId("artifact", artifact.id),
      label: "contains artifact",
      authority: "project_artifact.project_id",
      relationshipId: artifact.id,
    });
  }

  for (const delegation of input.source.delegations) {
    if (!runsById.has(delegation.parentExecutionId)) continue;
    addNode(nodes, {
      id: nodeId("delegation", delegation.taskId),
      kind: "delegation",
      entityId: delegation.taskId,
      title: `${agentLabel(delegation.delegateAgentId)} delegation`,
      detail: `definition v${delegation.delegateDefinitionVersion} · revision ${delegation.lifecycleRevision}`,
      status: safeStatus(delegation.state),
      occurredAt: canonicalTimestamp(delegation.updatedAt),
      threadId: runsById.get(delegation.parentExecutionId)?.threadId || null,
      runId: delegation.parentExecutionId,
      projectId: null,
      contextAccess: notEstablishedContext(
        "Delegation lineage does not disclose or grant shared memory.",
      ),
    });
  }

  for (const delegation of input.source.delegations) {
    if (!nodes.has(nodeId("delegation", delegation.taskId))) continue;
    const parent = delegation.parentDelegationId
      ? delegationsById.get(delegation.parentDelegationId)
      : undefined;
    if (parent && nodes.has(nodeId("delegation", parent.taskId))) {
      addEdge(edges, {
        kind: "delegation_parent",
        from: nodeId("delegation", parent.taskId),
        to: nodeId("delegation", delegation.taskId),
        label: "delegated again",
        authority: "delegation_task.parent_delegation_id",
        relationshipId: delegation.delegationId,
      });
      continue;
    }
    addEdge(edges, {
      kind: "run_delegation",
      from: nodeId("run", delegation.parentExecutionId),
      to: nodeId("delegation", delegation.taskId),
      label: "delegated to",
      authority: "delegation_task.parent_execution_id",
      relationshipId: delegation.delegationId,
    });
  }

  for (const artifact of input.source.sharedArtifacts) {
    const sender = input.source.delegations.find(
      (delegation) => delegation.taskId === artifact.senderTaskId,
    );
    const recipients = artifact.recipientTaskIds.flatMap((taskId) => {
      const recipient = input.source.delegations.find(
        (delegation) => delegation.taskId === taskId,
      );
      return recipient ? [recipient] : [];
    });
    if (!sender && !recipients.length) continue;
    addNode(nodes, {
      id: nodeId("artifact", artifact.artifactId),
      kind: "artifact",
      entityId: artifact.artifactId,
      title: safeText(artifact.title, 200, "Shared artifact"),
      detail: `${safeText(artifact.kind, 60, "shared")} · mission shared`,
      status: "shared",
      occurredAt: canonicalTimestamp(artifact.createdAt),
      threadId: runsById.get(artifact.parentExecutionId)?.threadId || null,
      runId: artifact.parentExecutionId,
      projectId: null,
      contextAccess: notEstablishedContext(
        "The exact recipient list grants artifact visibility, not shared memory.",
      ),
    });
    if (sender && nodes.has(nodeId("delegation", sender.taskId))) {
      addEdge(edges, {
        kind: "delegation_artifact_produced",
        from: nodeId("delegation", sender.taskId),
        to: nodeId("artifact", artifact.artifactId),
        label: "produced artifact",
        authority: "delegation_artifact.sender",
        relationshipId: artifact.artifactId,
      });
    }
    for (const recipient of recipients) {
      if (!nodes.has(nodeId("delegation", recipient.taskId))) continue;
      addEdge(edges, {
        kind: "delegation_artifact_shared",
        from: nodeId("artifact", artifact.artifactId),
        to: nodeId("delegation", recipient.taskId),
        label: "shared with",
        authority: "delegation_artifact.recipients",
        relationshipId: `${artifact.artifactId}:${recipient.taskId}`,
      });
    }
  }

  const orderedNodes = [...nodes.values()].sort(compareNodes);
  const orderedEdges = [...edges.values()].sort(compareEdges);
  const counts = {
    conversation: orderedNodes.filter((node) => node.kind === "conversation").length,
    run: orderedNodes.filter((node) => node.kind === "run").length,
    project: orderedNodes.filter((node) => node.kind === "project").length,
    delegation: orderedNodes.filter((node) => node.kind === "delegation").length,
    artifact: orderedNodes.filter((node) => node.kind === "artifact").length,
  };
  const digest = canonicalJsonSha256({
    version: CONVERSATION_CANVAS_VERSION,
    nodes: orderedNodes,
    edges: orderedEdges,
    truncated: input.source.truncated,
  });
  return Object.freeze({
    version: CONVERSATION_CANVAS_VERSION,
    generatedAt,
    digest,
    nodes: Object.freeze(orderedNodes),
    edges: Object.freeze(orderedEdges),
    counts: Object.freeze(counts),
    memoryBoundary: Object.freeze({
      mode: "explicit_grants_only" as const,
      grantedRunCount: orderedNodes.filter(
        (node) => node.kind === "run" && node.contextAccess.state === "granted",
      ).length,
      detail: "Canvas edges show canonical lineage and scope only. Shared memory exists only where the run records explicit context grants.",
    }),
    truncated: input.source.truncated,
  });
}

function addNode(
  nodes: Map<string, ConversationCanvasNode>,
  node: ConversationCanvasNode,
) {
  if (!nodes.has(node.id)) nodes.set(node.id, Object.freeze(node));
}

function addEdge(
  edges: Map<string, ConversationCanvasEdge>,
  input: Omit<ConversationCanvasEdge, "id" | "contextAccess">,
) {
  const id = `canvas-edge:${canonicalJsonSha256(input)}`;
  if (edges.has(id)) return;
  edges.set(id, Object.freeze({
    ...input,
    id,
    contextAccess: Object.freeze({
      state: "not_implied" as const,
      detail: "This relationship does not grant or imply shared memory.",
    }),
  }));
}

function nodeId(kind: ConversationCanvasNodeKind, entityId: string) {
  return `${kind}:${entityId}`;
}

function runContextAccess(count: number | null): ConversationCanvasNode["contextAccess"] {
  if (count === null) return notEstablishedContext(
    "This run predates or lacks an exact execution-scope receipt.",
  );
  if (count < 1) return Object.freeze({
    state: "none" as const,
    grantCount: 0,
    detail: "The run recorded no context grants.",
  });
  return Object.freeze({
    state: "granted" as const,
    grantCount: count,
    detail: `${count} explicit context grant${count === 1 ? "" : "s"} recorded for this run.`,
  });
}

function notEstablishedContext(detail: string): ConversationCanvasNode["contextAccess"] {
  return Object.freeze({ state: "not_established" as const, grantCount: null, detail });
}

function compareNodes(left: ConversationCanvasNode, right: ConversationCanvasNode) {
  const kindOrder: Record<ConversationCanvasNodeKind, number> = {
    conversation: 0,
    run: 1,
    project: 2,
    delegation: 3,
    artifact: 4,
  };
  return kindOrder[left.kind] - kindOrder[right.kind] ||
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.id.localeCompare(right.id);
}

function compareEdges(left: ConversationCanvasEdge, right: ConversationCanvasEdge) {
  return left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.id.localeCompare(right.id);
}

function safeText(value: string, max: number, fallback: string) {
  const text = String(redactSensitive(value)).trim().slice(0, max);
  return text || fallback;
}

function safeStatus(value: string) {
  return safeText(value, 80, "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

function statusLabel(value: string) {
  return safeStatus(value).replaceAll("_", " ");
}

function modeLabel(value: string) {
  const mode = safeStatus(value);
  return ({
    orchestrate: "General",
    research: "Research",
    execute: "Tools",
    learn: "Knowledge",
  } as Record<string, string>)[mode] || "Conversation";
}

function agentLabel(value: string) {
  const text = safeText(value, 120, "Agent").replaceAll(/[-_]+/g, " ");
  return text.replace(/\b\w/g, (character) => character.toUpperCase());
}

function canonicalTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Conversation canvas timestamp is invalid.");
  }
  return date.toISOString();
}
