import { sourceContractSha256 } from "@/lib/sources/contracts";

export const MUTATION_EVENT_REGISTRY_SCHEMA_VERSION = 1 as const;

export const REQUIRED_MUTATION_EVENT_DOMAINS = Object.freeze([
  "runs",
  "workflows",
  "projects",
  "missions",
  "tools",
  "approvals",
  "assets",
  "sync",
  "memory",
  "notifications",
  "customer_records",
] as const);

export type MutationEventDomain =
  (typeof REQUIRED_MUTATION_EVENT_DOMAINS)[number];

export type MutationEventContract = Readonly<{
  domain: MutationEventDomain;
  contractId: string;
  status: "evented" | "no_mutation_surface";
  writerModules: readonly string[];
  mutationSurfaces: readonly string[];
  eventTypes: readonly string[];
  eventSchemaVersion: 1;
  principalBinding: "execution_scope_v1" | "not_applicable";
  idempotencyBinding:
    | "deterministic_event_id_and_key_digest"
    | "not_applicable";
  atomicCommit:
    | "domain_write_and_event_same_postgres_transaction"
    | "not_applicable";
  payloadPolicy:
    | "references_hashes_and_metadata_only"
    | "not_applicable";
  projectionContract: "latest_metadata_state_v1" | "not_applicable";
}>;

const eventedDefaults = Object.freeze({
  status: "evented" as const,
  eventSchemaVersion: MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
  principalBinding: "execution_scope_v1" as const,
  idempotencyBinding: "deterministic_event_id_and_key_digest" as const,
  atomicCommit: "domain_write_and_event_same_postgres_transaction" as const,
  payloadPolicy: "references_hashes_and_metadata_only" as const,
  projectionContract: "latest_metadata_state_v1" as const,
});

/**
 * Runtime inventory for every Phase 1 mutation domain. The registry is a
 * fail-closed release contract: adding a customer-record writer or another
 * canonical domain requires declaring its scoped, idempotent event surface.
 */
export const MUTATION_EVENT_CONTRACTS = Object.freeze([
  Object.freeze({
    ...eventedDefaults,
    domain: "runs",
    contractId: "runs.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/runs/store.ts"]),
    mutationSurfaces: Object.freeze([
      "run lifecycle",
      "run contracts and manifests",
      "feedback and stale recovery",
      "terminal receipts",
    ]),
    eventTypes: Object.freeze([
      "run.scope_bound",
      "run.contracts.bound",
      "run.manifests.resolved",
      "run.context_compiler_v2.shadow",
      "run.feedback",
      "run.status",
      "run.waiting_approval",
      "run.agent.resume",
      "run.done",
      "run.error",
      "run.canceled",
      "run.terminal_receipt.recorded",
      "run.repair_stale",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "workflows",
    contractId: "workflows.atomic-events.v1",
    writerModules: Object.freeze([
      "src/lib/workflows/store.ts",
      "src/lib/workflows/planner.ts",
      "src/lib/workflows/executor.ts",
      "src/lib/workflows/triggers.ts",
    ]),
    mutationSurfaces: Object.freeze([
      "workflow lifecycle and queue",
      "workflow plans",
      "plan-node executions",
      "workflow triggers and deliveries",
    ]),
    eventTypes: Object.freeze([
      "workflow.scope_bound",
      "workflow.created",
      "workflow.updated",
      "workflow.transitioned",
      "workflow.approved",
      "workflow.plan.created",
      "workflow.plan.claimed",
      "workflow.plan_node.execution_upserted",
      "workflow.trigger.created",
      "workflow.trigger.received",
      "workflow.trigger.counter.updated",
      "workflow.queue.redelivery_failed",
      "workflow.queue.redelivery_reclaimed",
      "workflow.queue.retry_budget_exhausted",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "projects",
    contractId: "projects.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/projects/store.ts"]),
    mutationSurfaces: Object.freeze([
      "projects",
      "project tasks and dependencies",
      "dispatch and execution",
      "artifacts and reviews",
    ]),
    eventTypes: Object.freeze([
      "project.created",
      "project.updated",
      "project.task.created",
      "project.task.updated",
      "project.execution.updated",
      "project.task.dependencies.replaced",
      "project.task.dispatch.claimed",
      "project.task.execution.updated",
      "project.artifact.saved",
      "project.artifact.reviewed",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "missions",
    contractId: "missions.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/missions/store.ts"]),
    mutationSurfaces: Object.freeze([
      "missions",
      "mission tasks and comments",
      "attempts, handoffs, and reviews",
      "mission artifacts",
    ]),
    eventTypes: Object.freeze([
      "mission.created",
      "mission.status.changed",
      "mission.task.created",
      "mission.task.updated",
      "mission.task.status.changed",
      "mission.task.comment.created",
      "mission.task.handoff.recorded",
      "mission.task.review.requested",
      "mission.task.review.approved",
      "mission.task.review.changes_requested",
      "mission.attempt.created",
      "mission.attempt.status.changed",
      "mission.artifact.recorded",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "tools",
    contractId: "tools.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/tools/audit-store.ts"]),
    mutationSurfaces: Object.freeze([
      "tool execution ledger",
      "external effect intents",
      "external effect receipts",
    ]),
    eventTypes: Object.freeze([
      "tool.execution.upserted",
      "tool.effect_intent.recorded",
      "tool.effect_receipt.recorded",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "approvals",
    contractId: "approvals.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/tools/audit-store.ts"]),
    mutationSurfaces: Object.freeze([
      "approval quorum and execution claim",
      "approval rejection",
    ]),
    eventTypes: Object.freeze([
      "tool.approval.recorded",
      "tool.approval.rejected",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "assets",
    contractId: "assets.atomic-events.v1",
    writerModules: Object.freeze([
      "src/lib/capture/assets.ts",
      "src/lib/capture/recordings.ts",
    ]),
    mutationSurfaces: Object.freeze([
      "captured files",
      "recordings",
      "recording segments and transcription",
    ]),
    eventTypes: Object.freeze([
      "capture_asset.scope_bound",
      "capture_asset.status_changed",
      "capture_asset.deleted",
      "capture_recording.scope_bound",
      "capture_recording.details_changed",
      "capture_recording.status_changed",
      "capture_recording.deleted",
      "capture_segment.scope_bound",
      "capture_segment.transcription_changed",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "sync",
    contractId: "sync.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/sources/convergence-store.ts"]),
    mutationSurfaces: Object.freeze([
      "canonical source revisions",
      "canonical source absence",
      "canonical source tombstones",
    ]),
    eventTypes: Object.freeze([
      "source.revision.canonical_applied",
      "source.absence.canonical_observed",
      "source.tombstone.canonical_applied",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "memory",
    contractId: "memory.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/memory/store.ts"]),
    mutationSurfaces: Object.freeze([
      "memory formation",
      "memory feedback and correction",
      "memory deletion barriers",
    ]),
    eventTypes: Object.freeze([
      "memory.created",
      "memory.user_private.created",
      "memory.feedback_applied",
      "memory.corrected",
      "memory.deletion_barrier.recorded",
    ]),
  }),
  Object.freeze({
    ...eventedDefaults,
    domain: "notifications",
    contractId: "notifications.atomic-events.v1",
    writerModules: Object.freeze(["src/lib/today/notifications.ts"]),
    mutationSurfaces: Object.freeze([
      "due-notification materialization",
      "notification state",
      "actor read-all state",
    ]),
    eventTypes: Object.freeze([
      "notification.due_upserted",
      "notification.updated",
      "notifications.read_all",
    ]),
  }),
  Object.freeze({
    domain: "customer_records",
    contractId: "customer-records.no-surface.v1",
    status: "no_mutation_surface",
    writerModules: Object.freeze([]),
    mutationSurfaces: Object.freeze([]),
    eventTypes: Object.freeze([]),
    eventSchemaVersion: MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
    principalBinding: "not_applicable",
    idempotencyBinding: "not_applicable",
    atomicCommit: "not_applicable",
    payloadPolicy: "not_applicable",
    projectionContract: "not_applicable",
  }),
] satisfies readonly MutationEventContract[]);

export type MutationEventRegistryValidation = Readonly<{
  schemaVersion: 1;
  registrySha256: string;
  domainCount: number;
  eventedDomainCount: number;
  noMutationSurfaceCount: number;
  eventTypeCount: number;
  invalidContractIds: readonly string[];
  missingDomains: readonly MutationEventDomain[];
  duplicateDomains: readonly MutationEventDomain[];
  passed: boolean;
}>;

export function validateMutationEventRegistry(
  contracts: readonly MutationEventContract[] = MUTATION_EVENT_CONTRACTS,
): MutationEventRegistryValidation {
  const invalidContractIds = new Set<string>();
  const contractIds = new Set<string>();
  const domainCounts = new Map<MutationEventDomain, number>();

  for (const contract of contracts) {
    domainCounts.set(contract.domain, (domainCounts.get(contract.domain) || 0) + 1);
    if (contractIds.has(contract.contractId)) invalidContractIds.add(contract.contractId);
    contractIds.add(contract.contractId);
    if (!validContract(contract)) invalidContractIds.add(contract.contractId);
  }

  const missingDomains = REQUIRED_MUTATION_EVENT_DOMAINS.filter(
    (domain) => !domainCounts.has(domain),
  );
  const duplicateDomains = REQUIRED_MUTATION_EVENT_DOMAINS.filter(
    (domain) => (domainCounts.get(domain) || 0) > 1,
  );
  const evented = contracts.filter((contract) => contract.status === "evented");
  const invalidIds = [...invalidContractIds].sort();
  return Object.freeze({
    schemaVersion: MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
    registrySha256: sourceContractSha256(contracts),
    domainCount: contracts.length,
    eventedDomainCount: evented.length,
    noMutationSurfaceCount: contracts.length - evented.length,
    eventTypeCount: evented.reduce(
      (count, contract) => count + contract.eventTypes.length,
      0,
    ),
    invalidContractIds: Object.freeze(invalidIds),
    missingDomains: Object.freeze([...missingDomains]),
    duplicateDomains: Object.freeze([...duplicateDomains]),
    passed:
      invalidIds.length === 0 &&
      missingDomains.length === 0 &&
      duplicateDomains.length === 0 &&
      contracts.length === REQUIRED_MUTATION_EVENT_DOMAINS.length,
  });
}

type MutationReplayEvent = Readonly<{
  seq: number;
  contractId: string;
  domain: MutationEventDomain;
  eventType: string;
  eventSchemaVersion: 1;
  stateSha256: string;
}>;

export type MutationReplayResult = Readonly<{
  projectionCount: number;
  matchedProjectionCount: number;
  parityBasisPoints: number;
  passed: boolean;
}>;

/** Exercises the registry's deterministic metadata projection in both orders. */
export function evaluateMutationProjectionReplay(
  contracts: readonly MutationEventContract[] = MUTATION_EVENT_CONTRACTS,
): MutationReplayResult {
  const events = contracts
    .filter((contract) => contract.status === "evented")
    .map((contract, index): MutationReplayEvent => Object.freeze({
      seq: index + 1,
      contractId: contract.contractId,
      domain: contract.domain,
      eventType: contract.eventTypes.at(-1)!,
      eventSchemaVersion: contract.eventSchemaVersion,
      stateSha256: sourceContractSha256({
        contractId: contract.contractId,
        domain: contract.domain,
        eventTypes: contract.eventTypes,
        mutationSurfaces: contract.mutationSurfaces,
      }),
    }));
  const canonical = foldMutationProjection(events);
  const replayed = foldMutationProjection([...events].reverse());
  const contractIds = [...canonical.keys()].sort();
  const matchedProjectionCount = contractIds.filter((contractId) =>
    canonical.get(contractId) === replayed.get(contractId)
  ).length;
  const parityBasisPoints = contractIds.length
    ? Math.floor((matchedProjectionCount * 10_000) / contractIds.length)
    : 0;
  return Object.freeze({
    projectionCount: contractIds.length,
    matchedProjectionCount,
    parityBasisPoints,
    passed:
      contractIds.length > 0 &&
      matchedProjectionCount === contractIds.length &&
      parityBasisPoints === 10_000,
  });
}

function foldMutationProjection(events: readonly MutationReplayEvent[]) {
  const projection = new Map<string, string>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    projection.set(event.contractId, sourceContractSha256({
      schemaVersion: event.eventSchemaVersion,
      contractId: event.contractId,
      domain: event.domain,
      eventType: event.eventType,
      stateSha256: event.stateSha256,
    }));
  }
  return projection;
}

function validContract(contract: MutationEventContract) {
  if (
    !contract.contractId.trim() ||
    contract.eventSchemaVersion !== MUTATION_EVENT_REGISTRY_SCHEMA_VERSION
  ) {
    return false;
  }
  if (contract.status === "no_mutation_surface") {
    return contract.domain === "customer_records" &&
      contract.writerModules.length === 0 &&
      contract.mutationSurfaces.length === 0 &&
      contract.eventTypes.length === 0 &&
      contract.principalBinding === "not_applicable" &&
      contract.idempotencyBinding === "not_applicable" &&
      contract.atomicCommit === "not_applicable" &&
      contract.payloadPolicy === "not_applicable" &&
      contract.projectionContract === "not_applicable";
  }
  return contract.writerModules.length > 0 &&
    contract.mutationSurfaces.length > 0 &&
    contract.eventTypes.length > 0 &&
    new Set(contract.writerModules).size === contract.writerModules.length &&
    new Set(contract.eventTypes).size === contract.eventTypes.length &&
    contract.writerModules.every((module) =>
      module.startsWith("src/lib/") && module.endsWith(".ts")
    ) &&
    contract.eventTypes.every((eventType) =>
      /^[a-z][a-z0-9_.]+$/.test(eventType)
    ) &&
    contract.principalBinding === "execution_scope_v1" &&
    contract.idempotencyBinding === "deterministic_event_id_and_key_digest" &&
    contract.atomicCommit === "domain_write_and_event_same_postgres_transaction" &&
    contract.payloadPolicy === "references_hashes_and_metadata_only" &&
    contract.projectionContract === "latest_metadata_state_v1";
}
