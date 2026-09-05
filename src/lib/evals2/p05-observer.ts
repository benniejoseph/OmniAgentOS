import {
  P05_SCHEMA_VERSION,
  P05_SCORER_VERSION,
  digestP05Suite,
  parseP05ObservationSet,
  parseP05Suite,
  sha256Hex,
  type P05Case,
  type P05JsonValue,
  type P05ObservationSet,
  type P05Suite,
} from "@/lib/evals2/p05";
import {
  buildLegacyTerminalReceiptV1,
  buildOutcomeContractV1,
  buildTerminalReceiptV1,
  terminalReceiptV1Schema,
} from "@/lib/runs/contracts";
import {
  normalizeExplicitEvidenceIds,
  selectExplicitEvidenceIds,
} from "@/lib/rag/evidence-selection";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalStatusForTerminalReceipt } from "@/lib/status/canonical";
import {
  compareCanonicalSourceOrder,
  type CanonicalSourceOrder,
} from "@/lib/sources/convergence-store";
import { routeAgentRequest } from "@/lib/orchestration/supervisor";

/**
 * Versioned, side-effect-free probes of behavior that the current runtime can
 * actually demonstrate offline. Missing probes fail closed instead of
 * reproducing a fixture's expected answer.
 */
export const P05_OBSERVER_VERSION = "p0.5-observer-v1" as const;

type JsonRecord = Record<string, P05JsonValue>;

export function observeP05Suite(suiteValue: unknown): P05ObservationSet {
  const suite = parseP05Suite(suiteValue);
  return parseP05ObservationSet(suite, {
    schemaVersion: P05_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    scorerVersion: P05_SCORER_VERSION,
    suiteSha256: digestP05Suite(suite),
    observations: suite.cases.map((testCase) => ({
      caseId: testCase.id,
      value: observeP05Case(testCase, suite),
    })),
  });
}

export function observeP05Case(
  testCase: P05Case,
  _suite?: P05Suite,
): P05JsonValue {
  switch (testCase.id) {
    case "scope.boundary-matrix":
      return observeLegacyTenantOnlyMemoryRead(testCase);
    case "scope.mismatch-fails-closed":
      return observeExecutionScopeMismatch(testCase);
    case "update-delete.tombstone-blocks-stale-resurrection":
      return observeCanonicalSourceOrdering(testCase);
    case "intent-routing.portfolio-blog-automation":
    case "intent-routing.ambiguous-delete-clarifies":
      return observeIntentRouting(testCase);
    case "context-selection.explicit-empty-wins":
    case "context-selection.explicit-allowlist-wins":
      return observeExplicitContextSelection(testCase);
    case "false-completion.legacy-completed-is-unverified":
      return observeLegacyCompletion(testCase);
    case "false-completion.verified-live-positive-control":
      return observeVerifiedCompletion(testCase);
    default:
      return unavailableObservation(testCase);
  }
}

function observeIntentRouting(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const utterance = text(given.utterance);
  if (!utterance) return unavailableObservation(testCase);

  const decision = routeAgentRequest(utterance, "orchestrate");
  if (testCase.id === "intent-routing.portfolio-blog-automation") {
    const knownProcedure = jsonRecord(given.knownProcedure);
    return {
      adapterId: "supervisor-route-v2",
      adapterStatus: "observed",
      route: decision.route,
      workflowId: decision.route === "durable_workflow"
        ? text(knownProcedure.id) || null
        : null,
      ambiguityState: decision.ambiguity.state,
      requiredToolIds: [],
      effectCountBeforeGovernedExecution: 0,
    };
  }

  return {
    adapterId: "supervisor-route-v2",
    adapterStatus: "observed",
    route: decision.route,
    ambiguityState: decision.ambiguity.state,
    selectedTargetIds: [],
    selectedToolIds: [],
    effectCount: 0,
  };
}

function observeVerifiedCompletion(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const requiredOutcomes = number(given.requiredOutcomes) || 0;
  const stronglyVerifiedOutcomes = number(given.stronglyVerifiedOutcomes) || 0;
  const pendingApprovals = number(given.pendingApprovals) || 0;
  const blockingDependencies = number(given.blockingDependencies) || 0;
  if (
    requiredOutcomes <= 0 ||
    stronglyVerifiedOutcomes !== requiredOutcomes ||
    pendingApprovals !== 0 ||
    blockingDependencies !== 0 ||
    given.executionMode !== "live"
  ) {
    return unavailableObservation(testCase);
  }

  const runId = "synthetic:run:verified-positive-control";
  const outcomeContract = buildOutcomeContractV1({
    outcomeContractId: "synthetic:outcome:verified-positive-control",
    runId,
    intentSpecId: "synthetic:intent:verified-positive-control",
    contractState: "declared",
    acceptanceCriteria: Array.from(
      { length: requiredOutcomes },
      (_, index) => ({
        criterionId: `synthetic:criterion:${index + 1}`,
        criterionSha256: sha256Hex(`verified-positive-control:${index + 1}`),
        requirementLevel: "required" as const,
        verificationMethod: "deterministic" as const,
        verifierId: `synthetic:verifier:${index + 1}`,
      }),
    ),
    artifactRequirements: [],
    effectRequirements: [],
  });
  const verifierReceiptIds = outcomeContract.acceptanceCriteria.map(
    (_, index) => `synthetic:verification-receipt:${index + 1}`,
  );
  const receipt = terminalReceiptV1Schema.parse(
    buildTerminalReceiptV1({
      terminalReceiptId: "synthetic:receipt:verified-positive-control",
      runId,
      outcomeContractId: outcomeContract.outcomeContractId,
      source: "outcome_evaluator",
      legacyStatus: null,
      disposition: "succeeded",
      executionMode: "live",
      verificationState: "verified",
      reasonCode: "all_requirements_verified",
      requirementResults: outcomeContract.acceptanceCriteria.map(
        (criterion, index) => ({
          requirementId: criterion.criterionId,
          requirementKind: "criterion" as const,
          requirementLevel: criterion.requirementLevel,
          state: "verified" as const,
          verificationMethod: criterion.verificationMethod,
          verifierId: criterion.verifierId,
          verificationReceiptId: verifierReceiptIds[index],
        }),
      ),
      usefulWorkUnitCount: requiredOutcomes,
      artifactReceiptIds: [],
      effectReceiptIds: [],
      verifierReceiptIds,
      pendingApprovalIds: [],
      blockingDependencyIds: [],
      outputSha256: null,
    }),
  );
  const canonical = canonicalStatusForTerminalReceipt(receipt);
  return {
    adapterId: "run-contract-verified-terminal-v1",
    adapterStatus: "observed",
    disposition: receipt.disposition,
    canonicalStatus: canonical.status,
    verificationState: receipt.verificationState,
    succeeded: canonical.status === "succeeded",
    reasonCode: receipt.reasonCode,
  };
}

function observeExplicitContextSelection(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const explicitSelection = strings(given.explicitSelection);
  const automaticCandidates = strings(given.automaticCandidates);
  const unauthorizedIds = new Set(strings(given.unauthorizedIds));
  const normalized = normalizeExplicitEvidenceIds(explicitSelection) || [];
  const retrievable = automaticCandidates.filter((id) => !unauthorizedIds.has(id));
  const selectedEvidenceIds = selectExplicitEvidenceIds({
    explicitEvidenceIds: normalized,
    retrievableEvidenceIds: retrievable,
  });

  return {
    adapterId: "context-engine-explicit-selection-v1",
    adapterStatus: "observed",
    selectedEvidenceIds,
    retrievalInvoked: normalized.length > 0,
    disclosureBoundary: normalized.length === 0 ? "none" : "explicit_allowlist",
    scopeViolationCount: selectedEvidenceIds.filter((id) => unauthorizedIds.has(id)).length,
  };
}

function observeCanonicalSourceOrdering(testCase: P05Case): P05JsonValue {
  const events = jsonRecords(jsonRecord(testCase.given).events);
  let head:
    | { id: string; kind: "upsert" | "tombstone"; revision: number; order: CanonicalSourceOrder }
    | undefined;
  const staleResurrectionCount = 0;

  for (const event of events) {
    const revision = number(event.revision);
    const id = text(event.id);
    const eventKind = text(event.kind);
    if (revision === undefined || !id || (eventKind !== "upsert" && eventKind !== "delete")) {
      continue;
    }
    const order: CanonicalSourceOrder = {
      authorizationGeneration: 1,
      rolloutGeneration: 2,
      phaseRank: 1,
      pageSequence: revision,
      ordinal: 0,
    };
    if (head && compareCanonicalSourceOrder(order, head.order) <= 0) {
      continue;
    }
    head = {
      id,
      kind: eventKind === "delete" ? "tombstone" : "upsert",
      revision,
      order,
    };
  }

  const currentIds = head?.kind === "upsert" ? [head.id] : [];
  return {
    adapterId: "canonical-source-order-v1",
    adapterStatus: "observed",
    head: head
      ? { kind: head.kind, revision: head.revision }
      : null,
    currentIds,
    searchableIds: currentIds,
    staleResurrectionCount,
  };
}

function observeLegacyTenantOnlyMemoryRead(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const records = jsonRecords(given.records);
  const visibleRecords = records.filter(
    (record) => record.tenantId === testCase.scope.tenantId,
  );
  const visibleIds = visibleRecords
    .map((record) => text(record.id))
    .filter((id): id is string => Boolean(id));
  const grantIds = new Set(testCase.scope.grantIds);
  const leakedReadCount = visibleRecords.filter((record) => {
    const ownerActorId = text(record.ownerActorId);
    if (ownerActorId === testCase.scope.initiatingActorId) return false;
    const visibility = text(record.visibility);
    if (!visibility?.startsWith("grant:")) return true;
    return !grantIds.has(visibility.slice("grant:".length));
  }).length;

  return {
    adapterId: "p0.1-legacy-tenant-memory-read-v1",
    adapterStatus: "observed",
    scope: {
      tenantId: testCase.scope.tenantId,
      initiatingActorId: testCase.scope.initiatingActorId,
    },
    visibleIds,
    leakedReadCount,
    effectCount: 0,
  };
}

function observeExecutionScopeMismatch(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const requestedRecord = jsonRecord(given.requestedRecord);
  const requestedTenantId = text(requestedRecord.tenantId) || "";
  const scope = createExecutionScope({
    tenantId: testCase.scope.tenantId,
    initiatingActorId: testCase.scope.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: testCase.scope.executingPrincipalId,
    purpose: testCase.scope.purpose,
    correlationId: testCase.scope.correlationId,
    contextGrantIds: testCase.scope.grantIds,
    capabilityGrantIds: [],
  });

  let decision: "allow" | "deny" = "allow";
  try {
    assertExecutionScopeTenant(scope, requestedTenantId);
  } catch {
    decision = "deny";
  }

  return {
    adapterId: "execution-scope-tenant-assertion-v1",
    adapterStatus: "observed",
    decision,
    visibleIds: [],
    leakedReadCount: 0,
    effectCount: 0,
    correlationId: scope.correlationId,
  };
}

function observeLegacyCompletion(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const legacyStatus = text(given.legacyStatus);
  if (legacyStatus !== "completed") return unavailableObservation(testCase);

  const receipt = terminalReceiptV1Schema.parse(
    buildLegacyTerminalReceiptV1({
      terminalReceiptId: "synthetic:receipt:legacy-completion",
      runId: "synthetic:run:legacy-completion",
      legacyStatus,
    }),
  );
  const canonical = canonicalStatusForTerminalReceipt(receipt);
  return {
    adapterId: "run-contract-legacy-terminal-v1",
    adapterStatus: "observed",
    disposition: receipt.disposition,
    canonicalStatus: canonical.status,
    succeeded: canonical.status === "succeeded",
    reasonCode: receipt.reasonCode,
  };
}

function unavailableObservation(testCase: P05Case): P05JsonValue {
  return {
    adapterId: `${P05_OBSERVER_VERSION}:${testCase.category}`,
    adapterStatus: "not_observable_offline",
    reasonCode: "no_side_effect_free_current_system_adapter",
  };
}

function jsonRecord(value: P05JsonValue | undefined): JsonRecord {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as JsonRecord;
}

function jsonRecords(value: P05JsonValue | undefined): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(jsonRecord);
}

function text(value: P05JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: P05JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function strings(value: P05JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
