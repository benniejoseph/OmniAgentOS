import type { AgentDefinitionV1 } from "@/lib/agents/identity-contracts";
import {
  AGENT_COUNCIL_MAP_VERSION,
  parseAgentCouncilMap,
  type AgentCouncilMap,
} from "@/lib/agents/council-map-contract";
import type { DelegationChannelRecord } from "@/lib/delegation/channel-store";
import {
  parseDelegationAuthorityReceiptV1,
  type DelegationAuthorityReceiptV1,
} from "@/lib/delegation/authority-receipt";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import type { DelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import type { DomainEvent } from "@/lib/events/store";
import type { RunStatus } from "@/lib/runs/types";
import { redactSensitive } from "@/lib/security/context";

export type AgentCouncilRunSource = Readonly<{
  id: string;
  ownerActorId: string;
  status: RunStatus;
  prompt: string;
  startedAt: string;
  completedAt?: string;
}>;

export type AgentCouncilIdentitySource = Readonly<{
  ownerActorId: string;
  definition: AgentDefinitionV1;
}>;

export type AgentCouncilMemberEventSource = Readonly<{
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  status: "thinking" | "completed" | "failed";
  summary?: string;
  confidence?: number;
  createdAt: string;
}>;

export type AgentCouncilUsageSource = Readonly<{
  key: string;
  receiptCount: number;
  unknownCostReceiptCount: number;
  totalTokens: number;
  knownEstimatedCostMicrousd: number;
}>;

export type AgentCouncilChannelSource = Readonly<{
  ownerActorId: string;
  missionId: string;
  state: "available" | "unavailable";
  records: readonly DelegationChannelRecord[];
}>;

export type AgentCouncilMapSource = Readonly<{
  state: "available" | "unavailable";
  tasks: readonly DelegationTaskV1[];
  executionRecords?: readonly DelegationExecutionRecordV1[];
  runs: readonly AgentCouncilRunSource[];
  authorityEvents: readonly DomainEvent[];
  identities: readonly AgentCouncilIdentitySource[];
  memberEvents: readonly AgentCouncilMemberEventSource[];
  channels: readonly AgentCouncilChannelSource[];
  memberUsage: readonly AgentCouncilUsageSource[];
  verifierUsage: readonly AgentCouncilUsageSource[];
}>;

type CouncilMember = AgentCouncilMap["executions"][number]["members"][number];
type CouncilExecution = AgentCouncilMap["executions"][number];
type CouncilCost = CouncilMember["cost"];
type CouncilIdentity = CouncilMember["identity"];

const activeStates = new Set<DelegationTaskV1["state"]>([
  "proposed",
  "accepted",
  "working",
  "waiting",
  "challenged",
  "completed_proposed",
]);

export function buildAgentCouncilMap(input: {
  source: AgentCouncilMapSource;
  generatedAt?: string;
}): AgentCouncilMap {
  const generatedAt = timestamp(input.generatedAt || new Date().toISOString());
  if (input.source.state === "unavailable") {
    return parseAgentCouncilMap({
      version: AGENT_COUNCIL_MAP_VERSION,
      authority: "canonical_delegation_ledger",
      generatedAt,
      state: "unavailable",
      summary: emptySummary(),
      executions: [],
    });
  }

  const executionRecords = [...(input.source.executionRecords || [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 100);
  const tasks = [...input.source.tasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(0, 100 - executionRecords.length));
  const runs = new Map(input.source.runs.map((run) => [runKey(run.ownerActorId, run.id), run]));
  const events = authorityEventMap(input.source.authorityEvents);
  const identities = new Map(input.source.identities.map((identity) => [
    identityKey(
      identity.ownerActorId,
      identity.definition.logicalAgentId,
      identity.definition.definitionVersion,
    ),
    identity,
  ]));
  const memberEvents = latestMemberEvents(input.source.memberEvents);
  const channels = new Map(input.source.channels.map((channel) => [
    channelKey(channel.ownerActorId, channel.missionId),
    channel,
  ]));
  const memberUsage = new Map(input.source.memberUsage.map((usage) => [usage.key, usage]));
  const verifierUsage = new Map(input.source.verifierUsage.map((usage) => [usage.key, usage]));
  const groups = new Map<string, DelegationTaskV1[]>();
  for (const task of tasks) {
    const group = groups.get(task.parentExecutionId) || [];
    if (group.length < 20) group.push(task);
    groups.set(task.parentExecutionId, group);
  }

  const legacyExecutions: CouncilExecution[] = [...groups.entries()].slice(0, 50).map(([parentExecutionId, group]) => {
    const first = group[0];
    const run = runs.get(runKey(first.ownerActorId, parentExecutionId));
    const currentWork = safeText(
      run?.prompt,
      4_000,
      "Historical delegated work (run detail unavailable).",
    );
    const members = group.map((task) => {
      const authority = verifiedAuthority(task, events.get(task.taskId));
      const candidateMemberEvent = memberEvents.get(task.taskId);
      const memberEvent = candidateMemberEvent?.runId === task.parentExecutionId &&
          candidateMemberEvent.agentId === task.delegateAgentId
        ? candidateMemberEvent
        : undefined;
      const identity = displayIdentity(
        identities.get(identityKey(
          task.ownerActorId,
          task.delegateAgentId,
          task.delegateDefinitionVersion,
        )),
        task.delegateAgentId,
        task.delegateDefinitionVersion,
      );
      const verifierIdentity = displayIdentity(
        identities.get(identityKey(
          task.ownerActorId,
          task.verifierAgentId,
          task.verifierDefinitionVersion,
        )),
        task.verifierAgentId,
        task.verifierDefinitionVersion,
      );
      const channel = authority?.scope.missionId
        ? channels.get(channelKey(task.ownerActorId, authority.scope.missionId))
        : undefined;
      return {
        taskId: task.taskId,
        delegationId: task.delegationId,
        identity,
        state: task.state,
        lifecycleRevision: task.lifecycleRevision,
        canCancel: false,
        currentWork,
        updatedAt: timestamp(task.updatedAt),
        authority: authorityProjection(task, authority),
        messages: messageProjection(task, authority, channel),
        outputs: outputProjection(task, memberEvent, channel),
        cost: costProjection(memberUsage.get(task.delegationId)),
        confidence: memberEvent?.confidence ?? task.evaluation?.score ?? null,
        verifier: {
          identity: verifierIdentity,
          acceptanceThreshold: task.verifierAcceptanceThreshold,
          method: authority?.verifier.method || "historical_unavailable",
          verdict: verifierVerdict(task.state),
          score: task.evaluation?.score ?? null,
        },
      } satisfies CouncilMember;
    });
    return {
      parentExecutionId,
      href: `/app/command?run=${encodeURIComponent(parentExecutionId)}`,
      status: run?.status || "unavailable",
      currentWork,
      startedAt: timestamp(run?.startedAt || first.createdAt),
      updatedAt: timestamp(
        [run?.completedAt, ...group.map((task) => task.updatedAt)]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) || first.updatedAt,
      ),
      members,
      verifierCost: costProjection(verifierUsage.get(parentExecutionId)),
    };
  });
  const executions = mergeCouncilExecutions(
    legacyExecutions,
    projectExecutionRecords({
      records: executionRecords,
      runs,
      identities,
      memberUsage,
      verifierUsage,
    }),
  ).slice(0, 50);
  const members = executions.flatMap((execution) => execution.members);
  return parseAgentCouncilMap({
    version: AGENT_COUNCIL_MAP_VERSION,
    authority: "canonical_delegation_ledger",
    generatedAt,
    state: members.length ? "ready" : "empty",
    summary: {
      executionCount: executions.length,
      memberCount: members.length,
      activeMemberCount: members.filter((member) => activeStates.has(member.state)).length,
      waitingMemberCount: members.filter((member) => member.state === "waiting").length,
      acceptedMemberCount: members.filter((member) => member.state === "result_accepted").length,
      knownEstimatedCostMicrousd: executions.reduce(
        (total, execution) => total + execution.verifierCost.knownEstimatedCostMicrousd +
          execution.members.reduce((sum, member) => sum + member.cost.knownEstimatedCostMicrousd, 0),
        0,
      ),
    },
    executions,
  });
}

function projectExecutionRecords(input: {
  records: readonly DelegationExecutionRecordV1[];
  runs: ReadonlyMap<string, AgentCouncilRunSource>;
  identities: ReadonlyMap<string, AgentCouncilIdentitySource>;
  memberUsage: ReadonlyMap<string, AgentCouncilUsageSource>;
  verifierUsage: ReadonlyMap<string, AgentCouncilUsageSource>;
}): CouncilExecution[] {
  const groups = new Map<string, DelegationExecutionRecordV1[]>();
  for (const record of input.records) {
    const group = groups.get(record.parentExecutionId) || [];
    if (group.length < 20) group.push(record);
    groups.set(record.parentExecutionId, group);
  }
  return [...groups.entries()].map(([parentExecutionId, group]) => {
    const first = group[0];
    const run = input.runs.get(runKey(first.ownerActorId, parentExecutionId));
    const currentWork = safeText(
      run?.prompt,
      4_000,
      first.contract.objective,
    );
    const members = group.map((record): CouncilMember => {
      const contract = record.contract;
      const identity = displayIdentity(
        input.identities.get(identityKey(
          record.ownerActorId,
          contract.delegateIdentity.logicalAgentId,
          contract.delegateIdentity.definitionVersion,
        )),
        contract.delegateIdentity.logicalAgentId,
        contract.delegateIdentity.definitionVersion,
      );
      const verifierIdentity = displayIdentity(
        input.identities.get(identityKey(
          record.ownerActorId,
          contract.verifier.identity.logicalAgentId,
          contract.verifier.identity.definitionVersion,
        )),
        contract.verifier.identity.logicalAgentId,
        contract.verifier.identity.definitionVersion,
      );
      const result = record.result;
      const artifact = result?.artifacts[0];
      const outputItems = result && artifact
        ? [{
            artifactId: artifact.artifactId,
            title: `${identity.name} result`,
            kind: artifact.kind,
            mediaType: artifact.mediaType,
            content: safeText(result.summary, 4_000, "Result recorded"),
            createdAt: timestamp(result.proposedAt),
            trust: "untrusted_shared_content" as const,
          }]
        : [];
      return {
        taskId: record.executionId,
        delegationId: record.delegationId,
        identity,
        state: executionRecordCouncilState(record.state),
        lifecycleRevision: record.lifecycleRevision,
        canCancel: ["queued", "running", "waiting"].includes(record.state),
        currentWork: safeText(contract.objective, 4_000, "Delegated work"),
        updatedAt: timestamp(record.updatedAt),
        authority: {
          source: "delegation_grants",
          receiptSha256: contract.contractSha256,
          contractSha256: contract.contractSha256,
          purpose: contract.purpose,
          scope: {
            workspaceId: contract.lineage.workspaceId,
            projectId: contract.lineage.projectId,
            missionId: contract.lineage.workItemId,
          },
          context: {
            state: contract.grants.contextGrantIds.length ? "granted" : "none",
            grantCount: contract.grants.contextGrantIds.length,
          },
          capabilities: {
            state: contract.grants.capabilityGrantIds.length ? "granted" : "none",
            grantCount: contract.grants.capabilityGrantIds.length,
          },
          tools: {
            state: contract.grants.governedToolIds.length ? "granted" : "none",
            ids: contract.grants.governedToolIds,
          },
          budgets: {
            modelTurns: contract.budgets.modelTurns,
            tokens: contract.budgets.tokens,
            costMicrousd: contract.budgets.costMicrousd,
            wallTimeMs: contract.budgets.wallTimeMs,
            toolCalls: contract.budgets.toolCalls,
            browserActions: contract.budgets.browserActions,
          },
        },
        messages: { state: "not_applicable", items: [] },
        outputs: {
          state: outputItems.length
            ? "shared"
            : result
              ? "receipt_only"
              : "none",
          items: outputItems,
          proposalReceiptSha256: record.resultSha256,
        },
        cost: costProjection(input.memberUsage.get(record.delegationId)),
        confidence: record.verification?.score ?? null,
        verifier: {
          identity: verifierIdentity,
          acceptanceThreshold: contract.verifier.acceptanceThreshold,
          method: contract.verifier.method,
          verdict: executionRecordVerifierVerdict(record.state),
          score: record.verification?.score ?? null,
        },
      };
    });
    return {
      parentExecutionId,
      href: `/app/command?run=${encodeURIComponent(parentExecutionId)}`,
      status: run?.status || "unavailable",
      currentWork,
      startedAt: timestamp(run?.startedAt || first.createdAt),
      updatedAt: timestamp(
        [run?.completedAt, ...group.map((record) => record.updatedAt)]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) || first.updatedAt,
      ),
      members,
      verifierCost: costProjection(input.verifierUsage.get(parentExecutionId)),
    };
  });
}

function mergeCouncilExecutions(
  legacy: readonly CouncilExecution[],
  current: readonly CouncilExecution[],
): CouncilExecution[] {
  const merged = new Map<string, CouncilExecution>();
  for (const execution of [...current, ...legacy]) {
    const existing = merged.get(execution.parentExecutionId);
    if (!existing) {
      merged.set(execution.parentExecutionId, execution);
      continue;
    }
    const members = [...existing.members, ...execution.members]
      .filter((member, index, all) =>
        all.findIndex((candidate) => candidate.taskId === member.taskId) === index
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
    merged.set(execution.parentExecutionId, {
      ...existing,
      status: existing.status === "unavailable" ? execution.status : existing.status,
      currentWork: existing.currentWork || execution.currentWork,
      startedAt: existing.startedAt < execution.startedAt
        ? existing.startedAt
        : execution.startedAt,
      updatedAt: existing.updatedAt > execution.updatedAt
        ? existing.updatedAt
        : execution.updatedAt,
      members,
      verifierCost: existing.verifierCost.state === "not_recorded"
        ? execution.verifierCost
        : existing.verifierCost,
    });
  }
  return [...merged.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function executionRecordCouncilState(
  state: DelegationExecutionRecordV1["state"],
): CouncilMember["state"] {
  return ({
    queued: "accepted",
    running: "working",
    waiting: "waiting",
    completed_proposed: "completed_proposed",
    verified: "result_accepted",
    rejected: "rejected",
    failed: "rejected",
    canceled: "canceled",
    expired: "expired",
  } as const)[state];
}

function executionRecordVerifierVerdict(
  state: DelegationExecutionRecordV1["state"],
): CouncilMember["verifier"]["verdict"] {
  if (state === "verified") return "accepted";
  if (state === "rejected") return "rejected";
  if (["failed", "canceled", "expired"].includes(state)) return "unavailable";
  return "pending";
}

function authorityEventMap(events: readonly DomainEvent[]) {
  const result = new Map<string, DomainEvent>();
  for (const event of events) {
    if (event.type !== "delegation.task.proposed") continue;
    const taskId = optionalText(event.payload.taskId);
    if (taskId && !result.has(taskId)) result.set(taskId, event);
  }
  return result;
}

function latestMemberEvents(events: readonly AgentCouncilMemberEventSource[]) {
  const result = new Map<string, AgentCouncilMemberEventSource>();
  for (const event of [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    if (!result.has(event.taskId)) result.set(event.taskId, event);
  }
  return result;
}

function verifiedAuthority(
  task: DelegationTaskV1,
  event?: DomainEvent,
): DelegationAuthorityReceiptV1 | undefined {
  if (!event?.executionScope) return undefined;
  try {
    const receipt = parseDelegationAuthorityReceiptV1(event.payload.authority);
    const scope = event.executionScope;
    if (
      event.tenantId !== task.tenantId ||
      event.actorId !== task.ownerActorId ||
      receipt.taskId !== task.taskId ||
      receipt.delegationId !== task.delegationId ||
      receipt.contractId !== task.contractId ||
      receipt.contractSha256 !== task.contractSha256 ||
      event.payload.taskId !== task.taskId ||
      event.payload.delegationId !== task.delegationId ||
      event.payload.detailSha256 !== task.contractSha256 ||
      scope.tenantId !== task.tenantId ||
      scope.initiatingActorId !== task.ownerActorId ||
      scope.executingPrincipalId !== task.delegatePrincipalId ||
      scope.delegationId !== task.delegationId ||
      scope.workspaceId !== receipt.scope.workspaceId ||
      scope.projectId !== receipt.scope.projectId ||
      scope.missionId !== receipt.scope.missionId ||
      !sameIds(scope.contextGrantIds, receipt.grants.contextGrantIds) ||
      !sameIds(scope.capabilityGrantIds, receipt.grants.capabilityGrantIds) ||
      receipt.verifier.agentId !== task.verifierAgentId ||
      receipt.verifier.definitionVersion !== task.verifierDefinitionVersion ||
      receipt.verifier.acceptanceThreshold !== task.verifierAcceptanceThreshold
    ) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function authorityProjection(
  task: DelegationTaskV1,
  receipt?: DelegationAuthorityReceiptV1,
): CouncilMember["authority"] {
  if (!receipt) return {
    source: "historical_unavailable",
    receiptSha256: null,
    contractSha256: task.contractSha256,
    purpose: "Historical delegation authority was not recorded for display.",
    scope: { workspaceId: null, projectId: null, missionId: null },
    context: { state: "unavailable", grantCount: 0 },
    capabilities: { state: "unavailable", grantCount: 0 },
    tools: { state: "unavailable", ids: [] },
    budgets: emptyBudgets(),
  };
  return {
    source: "delegation_grants",
    receiptSha256: receipt.receiptSha256,
    contractSha256: receipt.contractSha256,
    purpose: receipt.purpose,
    scope: receipt.scope,
    context: {
      state: receipt.grants.contextGrantIds.length ? "granted" : "none",
      grantCount: receipt.grants.contextGrantIds.length,
    },
    capabilities: {
      state: receipt.grants.capabilityGrantIds.length ? "granted" : "none",
      grantCount: receipt.grants.capabilityGrantIds.length,
    },
    tools: {
      state: receipt.grants.governedToolIds.length ? "granted" : "none",
      ids: receipt.grants.governedToolIds,
    },
    budgets: receipt.budgets,
  };
}

function messageProjection(
  task: DelegationTaskV1,
  authority: DelegationAuthorityReceiptV1 | undefined,
  channel: AgentCouncilChannelSource | undefined,
): CouncilMember["messages"] {
  if (!authority?.scope.missionId) return { state: "not_applicable", items: [] };
  if (!channel || channel.state === "unavailable") return { state: "unavailable", items: [] };
  const items = channel.records.flatMap((record) => {
    if (record.type !== "message") return [];
    const message = record.value;
    const sent = message.sender.taskId === task.taskId;
    const received = message.recipients.delegationTaskIds.includes(task.taskId);
    if (!sent && !received) return [];
    return [{
      messageId: message.messageId,
      kind: message.kind,
      body: safeText(message.body, 2_000, "Shared message"),
      direction: sent ? "sent" as const : "received" as const,
      createdAt: timestamp(message.createdAt),
      trust: "untrusted_shared_content" as const,
    }];
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50);
  return { state: "available", items };
}

function outputProjection(
  task: DelegationTaskV1,
  memberEvent: AgentCouncilMemberEventSource | undefined,
  channel: AgentCouncilChannelSource | undefined,
): CouncilMember["outputs"] {
  const channelItems = channel?.state === "available"
    ? channel.records.flatMap((record) => {
        if (record.type !== "artifact" || record.value.sender.taskId !== task.taskId) return [];
        const artifact = record.value;
        return [{
          artifactId: artifact.artifactId,
          title: safeText(artifact.title, 240, "Shared artifact"),
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          content: safeText(artifact.content, 8_000, ""),
          createdAt: timestamp(artifact.createdAt),
          trust: "untrusted_shared_content" as const,
        }];
      })
    : [];
  const eventItems = memberEvent?.summary ? [{
    artifactId: `run-event:${memberEvent.id}`,
    title: `${displayName(memberEvent.agentId)} contribution`,
    kind: "council_contribution",
    mediaType: "text/plain",
    content: safeText(memberEvent.summary, 8_000, "Contribution recorded"),
    createdAt: timestamp(memberEvent.createdAt),
    trust: "untrusted_shared_content" as const,
  }] : [];
  const items = [...channelItems, ...eventItems]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
  return {
    state: items.length ? "shared" : task.proposal ? "receipt_only" : "none",
    items,
    proposalReceiptSha256: task.proposal?.proposalReceiptSha256 || null,
  };
}

function displayIdentity(
  source: AgentCouncilIdentitySource | undefined,
  agentId: string,
  definitionVersion: number,
): CouncilIdentity {
  if (!source) return {
    agentId,
    name: displayName(agentId),
    role: "Historical agent",
    charter: "This exact historical AgentDefinition is unavailable.",
    visualIdentity: "Historical identity reference",
    definitionVersion,
    source: "historical_reference",
  };
  return {
    agentId: source.definition.logicalAgentId,
    name: source.definition.name,
    role: source.definition.role,
    charter: source.definition.persona.charter,
    visualIdentity: source.definition.persona.visualIdentity,
    definitionVersion: source.definition.definitionVersion,
    source: "agent_definition",
  };
}

function costProjection(source?: AgentCouncilUsageSource): CouncilCost {
  if (!source || source.receiptCount === 0) return {
    authority: "ai_usage_ledger_v1",
    state: "not_recorded",
    receiptCount: 0,
    unknownCostReceiptCount: 0,
    totalTokens: 0,
    knownEstimatedCostMicrousd: 0,
  };
  return {
    authority: "ai_usage_ledger_v1",
    state: source.unknownCostReceiptCount === 0
      ? "exact"
      : source.unknownCostReceiptCount === source.receiptCount
        ? "unknown"
        : "partial",
    receiptCount: source.receiptCount,
    unknownCostReceiptCount: source.unknownCostReceiptCount,
    totalTokens: source.totalTokens,
    knownEstimatedCostMicrousd: source.knownEstimatedCostMicrousd,
  };
}

function verifierVerdict(state: DelegationTaskV1["state"]): CouncilMember["verifier"]["verdict"] {
  if (state === "result_accepted") return "accepted";
  if (state === "rejected") return "rejected";
  if (state === "canceled" || state === "expired") return "unavailable";
  return "pending";
}

function emptySummary() {
  return {
    executionCount: 0,
    memberCount: 0,
    activeMemberCount: 0,
    waitingMemberCount: 0,
    acceptedMemberCount: 0,
    knownEstimatedCostMicrousd: 0,
  };
}

function emptyBudgets() {
  return {
    modelTurns: null,
    tokens: null,
    costMicrousd: null,
    wallTimeMs: null,
    toolCalls: null,
    browserActions: null,
  };
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function safeText(value: unknown, max: number, fallback: string) {
  const redacted = redactSensitive(value);
  return typeof redacted === "string" && redacted.trim()
    ? Array.from(redacted.trim()).slice(0, max).join("")
    : fallback;
}

function displayName(id: string) {
  const value = id.split(/[/:]/).at(-1) || id;
  return value.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Council timestamp is invalid.");
  return parsed.toISOString();
}

function runKey(ownerActorId: string, runId: string) {
  return `${ownerActorId}\0${runId}`;
}

function identityKey(ownerActorId: string, agentId: string, definitionVersion: number) {
  return `${ownerActorId}\0${agentId}\0${definitionVersion}`;
}

function channelKey(ownerActorId: string, missionId: string) {
  return `${ownerActorId}\0${missionId}`;
}
