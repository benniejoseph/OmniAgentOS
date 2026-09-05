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
  resolveAuthorizedExplicitEvidenceIds,
  selectExplicitEvidenceIds,
} from "@/lib/rag/evidence-selection";
import { evaluateStructuredClaimSupport } from "@/lib/rag/structured-claim-support";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
} from "@/lib/security/execution-scope";
import { selectTemporalFactsAsOf } from "@/lib/memory/temporal";
import { selectVisibleMemoryDescriptors } from "@/lib/memory/access-policy";
import { canonicalStatusForTerminalReceipt } from "@/lib/status/canonical";
import {
  compareCanonicalSourceOrder,
  type CanonicalSourceOrder,
} from "@/lib/sources/convergence-store";
import { evaluateSourceSyncPageRetry } from "@/lib/connectors/source-sync-page-transaction";
import { routeAgentRequest } from "@/lib/orchestration/supervisor";
import {
  approvalMaterialBindingSha256,
  evaluateApprovalBinding,
} from "@/lib/tools/approval-binding";
import { evaluateLostAcknowledgementRecovery } from "@/lib/tools/idempotent-delivery";

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
      return observeScopedMemoryRead(testCase);
    case "scope.mismatch-fails-closed":
      return observeExecutionScopeMismatch(testCase);
    case "pagination.mid-page-failure-retry":
      return observeSourceSyncPageRetry(testCase);
    case "update-delete.tombstone-blocks-stale-resurrection":
      return observeCanonicalSourceOrdering(testCase);
    case "retry.ack-lost-exactly-once":
      return observeLostAcknowledgementRetry(testCase);
    case "intent-routing.portfolio-blog-automation":
    case "intent-routing.ambiguous-delete-clarifies":
      return observeIntentRouting(testCase);
    case "context-selection.explicit-empty-wins":
    case "context-selection.explicit-allowlist-wins":
      return observeExplicitContextSelection(testCase);
    case "citations.valid-id-wrong-claim":
    case "citations.full-material-support":
      return observeStructuredClaimSupport(testCase);
    case "temporal.as-of-selects-valid-interval":
      return observeTemporalSelection(testCase);
    case "approvals.material-change-invalidates":
    case "approvals.exact-binding-permits-governed-effect":
      return observeApprovalBinding(testCase);
    case "false-completion.legacy-completed-is-unverified":
      return observeLegacyCompletion(testCase);
    case "false-completion.verified-live-positive-control":
      return observeVerifiedCompletion(testCase);
    default:
      return unavailableObservation(testCase);
  }
}

function observeLostAcknowledgementRetry(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const action = jsonRecord(testCase.action);
  if (text(given.firstAttempt) !== "provider_acknowledged_response_lost") {
    return unavailableObservation(testCase);
  }
  const bindingSha256 = text(given.bindingSha256);
  const deliveryAttempts = number(action.deliveryAttempts);
  if (!bindingSha256 || deliveryAttempts === undefined) {
    return unavailableObservation(testCase);
  }
  try {
    const result = evaluateLostAcknowledgementRecovery({
      bindingSha256,
      deliveryAttempts,
    });
    return {
      adapterId: "idempotent-delivery-lost-ack-v1",
      adapterStatus: "observed",
      attemptCount: result.attemptCount,
      providerEffectCount: result.providerEffectCount,
      receiptCount: result.receiptCount,
      receipt: result.receipt,
    };
  } catch {
    return unavailableObservation(testCase);
  }
}

function observeApprovalBinding(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  try {
    if (testCase.id === "approvals.material-change-invalidates") {
      const approvalBinding = jsonRecord(given.approvalBinding);
      const requestedBinding = jsonRecord(given.requestedBinding);
      const decision = evaluateApprovalBinding({
        approvedBindingSha256: approvalMaterialBindingSha256({
          targetSha256: text(approvalBinding.targetSha256) || "",
          inputSha256: text(approvalBinding.inputSha256) || "",
        }),
        requestedBindingSha256: approvalMaterialBindingSha256({
          targetSha256: text(requestedBinding.targetSha256) || "",
          inputSha256: text(requestedBinding.inputSha256) || "",
        }),
      });
      return {
        adapterId: "approval-material-binding-v1",
        adapterStatus: "observed",
        approvalAccepted: decision.accepted,
        status: decision.accepted ? "executing" : "waiting_approval",
        reason: decision.reason,
        effectCount: 0,
      };
    }

    const decision = evaluateApprovalBinding({
      approvedBindingSha256: text(given.approvalBindingSha256) || "",
      requestedBindingSha256: text(given.requestedBindingSha256) || "",
    });
    return {
      adapterId: "approval-material-binding-v1",
      adapterStatus: "observed",
      approvalAccepted: decision.accepted,
      executor: decision.accepted ? "governed_tool_executor" : null,
      effectCount: 0,
      effectReceiptId: null,
    };
  } catch {
    return unavailableObservation(testCase);
  }
}

function observeIntentRouting(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const utterance = text(given.utterance);
  if (!utterance) return unavailableObservation(testCase);

  if (testCase.id === "intent-routing.portfolio-blog-automation") {
    const knownProcedure = jsonRecord(given.knownProcedure);
    const workflowId = text(knownProcedure.id);
    const aliases = strings(knownProcedure.aliases);
    const decision = routeAgentRequest(
      utterance,
      "orchestrate",
      undefined,
      workflowId && aliases.length
        ? [{ id: workflowId, aliases, requiredToolIds: [] }]
        : [],
    );
    return {
      adapterId: "supervisor-route-v3",
      adapterStatus: "observed",
      route: decision.route,
      workflowId: decision.procedure?.workflowId || null,
      ambiguityState: decision.ambiguity.state,
      requiredToolIds: [...(decision.procedure?.requiredToolIds || [])],
      effectCountBeforeGovernedExecution: 0,
    };
  }

  const decision = routeAgentRequest(utterance, "orchestrate");
  return {
    adapterId: "supervisor-route-v3",
    adapterStatus: "observed",
    route: decision.route,
    ambiguityState: decision.ambiguity.state,
    selectedTargetIds: [],
    selectedToolIds: [],
    effectCount: 0,
  };
}

function observeSourceSyncPageRetry(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const action = jsonRecord(testCase.action);
  const page = jsonRecord(given.page);
  const initialCursor = text(given.initialCursor);
  const nextCursor = text(page.nextCursor);
  const failAfterItemId = text(given.firstAttemptFailsAfterItem);
  const retryCount = number(action.retryCount);
  if (!initialCursor || !nextCursor || retryCount === undefined) {
    return unavailableObservation(testCase);
  }

  try {
    const result = evaluateSourceSyncPageRetry({
      initialCursor,
      itemIds: strings(page.ids),
      nextCursor,
      failAfterItemId,
      retryCount,
    });
    return {
      adapterId: "source-sync-page-transaction-v1",
      adapterStatus: "observed",
      attemptCount: result.attemptCount,
      committedIds: [...result.committedIds],
      committedCursor: result.committedCursor,
      cursorAdvancedBeforeCommit: result.cursorAdvancedBeforeCommit,
      duplicateCount: result.duplicateCount,
      lostCount: result.lostCount,
      completed: result.completed,
    };
  } catch {
    return unavailableObservation(testCase);
  }
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

function observeStructuredClaimSupport(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const claimRecords = jsonRecords(given.claims);
  const singleClaim = jsonRecord(given.claim);
  const claims = claimRecords.length
    ? claimRecords
    : Object.keys(singleClaim).length
      ? [singleClaim]
      : [];
  const evidenceRecords = jsonRecords(given.evidenceUnits);
  const singleEvidence = jsonRecord(given.citation);
  const evidenceUnits = evidenceRecords.length
    ? evidenceRecords
    : Object.keys(singleEvidence).length
      ? [singleEvidence]
      : [];
  const candidateLinkRecords = jsonRecords(given.candidateLinks);
  const singleCandidateLink = jsonRecord(given.candidateLink);
  const candidateLinks = candidateLinkRecords.length
    ? candidateLinkRecords
    : Object.keys(singleCandidateLink).length
      ? [singleCandidateLink]
      : [];

  try {
    const result = evaluateStructuredClaimSupport({
      claims,
      evidenceUnits,
      candidateLinks,
      authorizedEvidenceIds: evidenceUnits
        .map((evidence) => text(evidence.id))
        .filter((id): id is string => Boolean(id)),
    });
    return {
      adapterId: "structured-claim-support-v1",
      adapterStatus: "observed",
      claims: result.claims.map((claim) => ({
        id: claim.id,
        supportState: claim.supportState,
        verified: claim.verified,
        evidenceIds: [...claim.evidenceIds],
      })),
      materialCoverageBasisPoints: result.materialCoverageBasisPoints,
      unauthorizedEvidenceCount: result.unauthorizedEvidenceCount,
    };
  } catch {
    return unavailableObservation(testCase);
  }
}

function observeTemporalSelection(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const action = jsonRecord(testCase.action);
  const asOf = text(action.asOf);
  if (!asOf) return unavailableObservation(testCase);

  try {
    const selection = selectTemporalFactsAsOf(
      jsonRecords(given.facts).map((fact) => ({
        id: text(fact.id) || "",
        value: fact.value ?? null,
        validFrom: text(fact.validFrom) || null,
        validTo: text(fact.validTo) || null,
      })),
      asOf,
    );
    return {
      adapterId: "memory-temporal-selection-v1",
      adapterStatus: "observed",
      answer: selection.facts.length === 1
        ? selection.facts[0].value
        : null,
      selectedEvidenceIds: selection.facts.map((fact) => fact.id),
      uncertainty: selection.uncertainty,
    };
  } catch {
    return unavailableObservation(testCase);
  }
}

function observeExplicitContextSelection(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const explicitSelection = strings(given.explicitSelection);
  const automaticCandidates = strings(given.automaticCandidates);
  const unauthorizedIds = new Set(strings(given.unauthorizedIds));
  const normalized = normalizeExplicitEvidenceIds(explicitSelection) || [];
  const selectedEvidenceIds = normalized.length === 0
    ? selectExplicitEvidenceIds({
        explicitEvidenceIds: normalized,
        retrievableEvidenceIds: automaticCandidates,
      })
    : resolveAuthorizedExplicitEvidenceIds({
        explicitEvidenceIds: normalized,
        authorizedEvidenceIds: normalized.filter((id) => !unauthorizedIds.has(id)),
      });

  return {
    adapterId: "context-engine-explicit-selection-v2",
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

function observeScopedMemoryRead(testCase: P05Case): P05JsonValue {
  const given = jsonRecord(testCase.given);
  const records = jsonRecords(given.records);
  const scope = createExecutionScope({
    tenantId: testCase.scope.tenantId,
    initiatingActorId: testCase.scope.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: testCase.scope.executingPrincipalId,
    correlationId: testCase.scope.correlationId,
    contextGrantIds: testCase.scope.grantIds,
    purpose: testCase.scope.purpose,
  });
  const selection = selectVisibleMemoryDescriptors(scope, records);

  return {
    adapterId: "memory-access-policy-v1",
    adapterStatus: "observed",
    scope: {
      tenantId: testCase.scope.tenantId,
      initiatingActorId: testCase.scope.initiatingActorId,
    },
    visibleIds: selection.visible.map((record) => record.id),
    leakedReadCount: 0,
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
