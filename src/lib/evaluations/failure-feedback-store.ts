import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  resolveIncidentByFingerprint,
  upsertIncidentFromSignal,
} from "@/lib/diagnostics/incidents";
import {
  buildHarnessRuleProposal,
  buildMinimizedReplayCase,
  FAILURE_RESOLUTION_PASS_THRESHOLD,
  failureClusterFingerprint,
  RECURRING_FAILURE_THRESHOLD,
  type EvaluationFailureCategory,
  type HarnessRuleKind,
  type HarnessRuleProposalV1,
  type MinimizedReplayCaseV1,
} from "@/lib/evaluations/failure-feedback";
import type {
  EvalCaseDefinition,
  EvalResultRecord,
} from "@/lib/evaluations/types";
import { appendDomainEvent } from "@/lib/events/store";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type FailureFeedbackStatus = "pass" | "fail" | "warn";
export type FailureClusterStatus = "active" | "resolved";
export type HarnessRuleProposalStatus = "proposed" | "approved" | "rejected";

export type FailureObservationRecord = {
  id: string;
  tenantId: string;
  evalRunId: string;
  sourceResultId: string;
  caseId: string;
  caseType: EvalCaseDefinition["type"];
  status: FailureFeedbackStatus;
  failureCategory?: EvaluationFailureCategory;
  failureFingerprint?: string;
  failureSignalSha256?: string;
  caseDefinitionSha256: string;
  observedAt: string;
};

export type FailureClusterRecord = {
  id: string;
  tenantId: string;
  fingerprint: string;
  caseId: string;
  caseType: EvalCaseDefinition["type"];
  failureCategory: EvaluationFailureCategory;
  status: FailureClusterStatus;
  failureCount: number;
  passCount: number;
  consecutiveFailures: number;
  consecutivePasses: number;
  replayCase: MinimizedReplayCaseV1;
  replayCaseSha256: string;
  latestEvalRunId: string;
  latestResultId: string;
  latestProposalVersion: number;
  lastProposalFailureCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type HarnessRuleProposalRecord = {
  id: string;
  tenantId: string;
  clusterId: string;
  version: number;
  kind: HarnessRuleKind;
  target: string;
  proposal: HarnessRuleProposalV1;
  proposalSha256: string;
  status: HarnessRuleProposalStatus;
  proposedBy: string;
  reviewedBy?: string;
  reviewReason?: string;
  proposedAt: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type FailureFeedbackLedger = {
  observations: FailureObservationRecord[];
  clusters: FailureClusterRecord[];
  proposals: HarnessRuleProposalRecord[];
};

type FailureFeedbackSqlClient = ReturnType<typeof getSql>;

export type FailureFeedbackSnapshot = {
  clusters: FailureClusterRecord[];
  proposals: HarnessRuleProposalRecord[];
  summary: {
    observations: number;
    activeClusters: number;
    activeRecurring: number;
    resolvedClusters: number;
    proposedRules: number;
    approvedRules: number;
    rejectedRules: number;
    byCategory: Record<string, number>;
  };
};

export type RecordEvaluationFeedbackResult = {
  processed: boolean;
  observation?: FailureObservationRecord;
  cluster?: FailureClusterRecord;
  proposal?: HarnessRuleProposalRecord;
  resolvedClusters: FailureClusterRecord[];
};

export class HarnessRuleReviewConflictError extends Error {}

export async function recordEvaluationResultFeedback({
  tenantId: rawTenantId,
  actorId: rawActorId,
  suite,
  evalCase,
  result,
}: {
  tenantId?: string;
  actorId?: string;
  suite: string;
  evalCase: EvalCaseDefinition;
  result: EvalResultRecord;
}): Promise<RecordEvaluationFeedbackResult> {
  const tenantId = normalizeTenantId(rawTenantId || result.tenantId);
  const actorId = normalizeActorId(rawActorId);
  const now = new Date().toISOString();
  const replayCase = result.status === "fail"
    ? buildMinimizedReplayCase({ suite, evalCase, result })
    : undefined;
  const fingerprint = replayCase
    ? failureClusterFingerprint(replayCase)
    : undefined;
  const observation: FailureObservationRecord = {
    id: randomUUID(),
    tenantId,
    evalRunId: result.evalRunId,
    sourceResultId: result.id,
    caseId: evalCase.id,
    caseType: evalCase.type,
    status: result.status,
    failureCategory: replayCase?.failureCategory,
    failureFingerprint: fingerprint,
    failureSignalSha256: replayCase?.failureSignalSha256,
    caseDefinitionSha256: replayCase?.caseDefinitionSha256 || canonicalJsonSha256(evalCase),
    observedAt: now,
  };

  const feedback = hasDatabaseUrl()
    ? await recordDatabaseFeedback({
        observation,
        actorId,
        replayCase,
        fingerprint,
        now,
      })
    : await recordFileFeedback({
        observation,
        actorId,
        replayCase,
        fingerprint,
        now,
      });

  if (!feedback.processed) return feedback;
  await recordFeedbackEvents(feedback, actorId);
  await syncFeedbackIncident(feedback, actorId);
  return feedback;
}

export async function listEvaluationFailureFeedback({
  tenantId: rawTenantId,
  limit = 50,
}: {
  tenantId?: string;
  limit?: number;
} = {}): Promise<FailureFeedbackSnapshot> {
  const tenantId = normalizeTenantId(rawTenantId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  let clusters: FailureClusterRecord[];
  let proposals: HarnessRuleProposalRecord[];
  let observations: number;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const [clusterRows, proposalRows, countRows] = await Promise.all([
      sql`
        SELECT * FROM omni_evaluation_failure_clusters
        WHERE tenant_id = ${tenantId}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `,
      sql`
        SELECT * FROM omni_harness_rule_proposals
        WHERE tenant_id = ${tenantId}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `,
      sql`
        SELECT COUNT(*)::INTEGER AS count
        FROM omni_evaluation_failure_observations
        WHERE tenant_id = ${tenantId}
      `,
    ]);
    clusters = clusterRows.map(clusterFromRow);
    proposals = proposalRows.map(proposalFromRow);
    observations = Number(countRows[0]?.count || 0);
  } else {
    const ledger = await readFailureFeedbackLedger();
    clusters = ledger.clusters
      .filter((item) => item.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit);
    proposals = ledger.proposals
      .filter((item) => item.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit);
    observations = ledger.observations.filter((item) => item.tenantId === tenantId).length;
  }

  return {
    clusters,
    proposals,
    summary: summarizeFeedback(clusters, proposals, observations),
  };
}

export async function reviewHarnessRuleProposal({
  tenantId: rawTenantId,
  proposalId,
  actorId: rawActorId,
  decision,
  reason: rawReason,
}: {
  tenantId?: string;
  proposalId: string;
  actorId: string;
  decision: "approved" | "rejected";
  reason: string;
}) {
  const tenantId = normalizeTenantId(rawTenantId);
  const actorId = normalizeActorId(rawActorId);
  const reason = rawReason.trim().slice(0, 500);
  if (reason.length < 12) {
    throw new Error("Harness rule review reason must be at least 12 characters.");
  }
  const now = new Date().toISOString();
  const proposal = hasDatabaseUrl()
    ? await reviewDatabaseProposal({ tenantId, proposalId, actorId, decision, reason, now })
    : await reviewFileProposal({ tenantId, proposalId, actorId, decision, reason, now });

  await appendDomainEvent({
    id: `harness-rule-review:${proposal.id}:${decision}`,
    streamId: `harness-rule:${proposal.clusterId}`,
    type: "harness.rule.reviewed",
    tenantId,
    actorId,
    correlationId: proposal.clusterId,
    causationId: proposal.id,
    payload: {
      schemaVersion: 1,
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      proposalSha256: proposal.proposalSha256,
      decision,
      reasonSha256: canonicalJsonSha256(reason),
      automaticApplication: false,
    },
  });
  return proposal;
}

async function recordDatabaseFeedback({
  observation,
  actorId,
  replayCase,
  fingerprint,
  now,
}: {
  observation: FailureObservationRecord;
  actorId: string;
  replayCase?: MinimizedReplayCaseV1;
  fingerprint?: string;
  now: string;
}): Promise<RecordEvaluationFeedbackResult> {
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: FailureFeedbackSqlClient) => {
    const inserted = await sql`
      INSERT INTO omni_evaluation_failure_observations (
        id, tenant_id, eval_run_id, source_result_id, case_id, case_type,
        status, failure_category, failure_fingerprint, failure_signal_sha256,
        case_definition_sha256, observed_at
      ) VALUES (
        ${observation.id}, ${observation.tenantId}, ${observation.evalRunId},
        ${observation.sourceResultId}, ${observation.caseId}, ${observation.caseType},
        ${observation.status}, ${observation.failureCategory || null},
        ${observation.failureFingerprint || null}, ${observation.failureSignalSha256 || null},
        ${observation.caseDefinitionSha256}, ${observation.observedAt}
      )
      ON CONFLICT (tenant_id, source_result_id) DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) {
      return { processed: false, resolvedClusters: [] };
    }

    if (observation.status === "fail" && replayCase && fingerprint) {
      let cluster = clusterFromRow((await sql`
        INSERT INTO omni_evaluation_failure_clusters (
          id, tenant_id, fingerprint, case_id, case_type, failure_category,
          status, failure_count, pass_count, consecutive_failures,
          consecutive_passes, replay_case, replay_case_sha256,
          latest_eval_run_id, latest_result_id, latest_proposal_version,
          last_proposal_failure_count, first_seen_at, last_seen_at,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${observation.tenantId}, ${fingerprint},
          ${observation.caseId}, ${observation.caseType}, ${replayCase.failureCategory},
          'active', 1, 0, 1, 0, ${replayCase}::jsonb,
          ${canonicalJsonSha256(replayCase)}, ${observation.evalRunId},
          ${observation.sourceResultId}, 0, 0, ${now}, ${now}, ${now}, ${now}
        )
        ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET
          status = 'active',
          failure_count = omni_evaluation_failure_clusters.failure_count + 1,
          consecutive_failures = omni_evaluation_failure_clusters.consecutive_failures + 1,
          consecutive_passes = 0,
          latest_eval_run_id = EXCLUDED.latest_eval_run_id,
          latest_result_id = EXCLUDED.latest_result_id,
          last_seen_at = EXCLUDED.last_seen_at,
          resolved_at = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `)[0]);
      const latestRows = await sql`
        SELECT * FROM omni_harness_rule_proposals
        WHERE tenant_id = ${observation.tenantId}
          AND cluster_id = ${cluster.id}
        ORDER BY version DESC
        LIMIT 1
      `;
      const latest = latestRows[0] ? proposalFromRow(latestRows[0]) : undefined;
      let proposal: HarnessRuleProposalRecord | undefined;
      if (shouldCreateProposal(cluster, latest)) {
        proposal = createProposalRecord({ cluster, replayCase, actorId, now });
        const proposalRows = await sql`
          INSERT INTO omni_harness_rule_proposals (
            id, tenant_id, cluster_id, version, kind, target, proposal,
            proposal_sha256, status, proposed_by, proposed_at, created_at, updated_at
          ) VALUES (
            ${proposal.id}, ${proposal.tenantId}, ${proposal.clusterId},
            ${proposal.version}, ${proposal.kind}, ${proposal.target},
            ${proposal.proposal}::jsonb, ${proposal.proposalSha256},
            ${proposal.status}, ${proposal.proposedBy}, ${proposal.proposedAt},
            ${proposal.createdAt}, ${proposal.updatedAt}
          )
          ON CONFLICT (tenant_id, cluster_id, version) DO NOTHING
          RETURNING *
        `;
        proposal = proposalRows[0] ? proposalFromRow(proposalRows[0]) : undefined;
        if (proposal) {
          const updatedRows = await sql`
            UPDATE omni_evaluation_failure_clusters
            SET latest_proposal_version = ${proposal.version},
                last_proposal_failure_count = failure_count,
                updated_at = ${now}
            WHERE tenant_id = ${observation.tenantId}
              AND id = ${cluster.id}
            RETURNING *
          `;
          cluster = clusterFromRow(updatedRows[0]);
        }
      }
      return { processed: true, observation, cluster, proposal, resolvedClusters: [] };
    }

    const resolvedClusters = observation.status === "pass"
      ? (await sql`
          UPDATE omni_evaluation_failure_clusters
          SET pass_count = pass_count + 1,
              consecutive_failures = 0,
              consecutive_passes = consecutive_passes + 1,
              status = CASE
                WHEN consecutive_passes + 1 >= ${FAILURE_RESOLUTION_PASS_THRESHOLD}
                THEN 'resolved'
                ELSE status
              END,
              resolved_at = CASE
                WHEN consecutive_passes + 1 >= ${FAILURE_RESOLUTION_PASS_THRESHOLD}
                THEN ${now}::timestamptz
                ELSE resolved_at
              END,
              latest_eval_run_id = ${observation.evalRunId},
              latest_result_id = ${observation.sourceResultId},
              last_seen_at = ${now},
              updated_at = ${now}
          WHERE tenant_id = ${observation.tenantId}
            AND case_id = ${observation.caseId}
            AND status = 'active'
          RETURNING *
        `).map(clusterFromRow).filter((cluster: FailureClusterRecord) =>
          cluster.status === "resolved"
        )
      : [];
    return { processed: true, observation, resolvedClusters };
  }) as Promise<RecordEvaluationFeedbackResult>;
}

async function recordFileFeedback({
  observation,
  actorId,
  replayCase,
  fingerprint,
  now,
}: {
  observation: FailureObservationRecord;
  actorId: string;
  replayCase?: MinimizedReplayCaseV1;
  fingerprint?: string;
  now: string;
}): Promise<RecordEvaluationFeedbackResult> {
  let feedback: RecordEvaluationFeedbackResult = {
    processed: false,
    resolvedClusters: [],
  };
  await updateJsonFile<FailureFeedbackLedger>(
    getFailureFeedbackFile(),
    emptyLedger(),
    (ledger) => {
      if (ledger.observations.some((item) =>
        item.tenantId === observation.tenantId &&
        item.sourceResultId === observation.sourceResultId
      )) {
        return ledger;
      }
      ledger.observations.push(observation);
      feedback = { processed: true, observation, resolvedClusters: [] };
      if (observation.status === "fail" && replayCase && fingerprint) {
        const index = ledger.clusters.findIndex((item) =>
          item.tenantId === observation.tenantId && item.fingerprint === fingerprint
        );
        const existing = index >= 0 ? ledger.clusters[index] : undefined;
        let cluster: FailureClusterRecord = existing
          ? {
              ...existing,
              status: "active",
              failureCount: existing.failureCount + 1,
              consecutiveFailures: existing.consecutiveFailures + 1,
              consecutivePasses: 0,
              latestEvalRunId: observation.evalRunId,
              latestResultId: observation.sourceResultId,
              lastSeenAt: now,
              resolvedAt: undefined,
              updatedAt: now,
            }
          : createClusterRecord({ observation, replayCase, fingerprint, now });
        const latest = ledger.proposals
          .filter((item) =>
            item.tenantId === observation.tenantId && item.clusterId === cluster.id
          )
          .sort((left, right) => right.version - left.version)[0];
        let proposal: HarnessRuleProposalRecord | undefined;
        if (shouldCreateProposal(cluster, latest)) {
          proposal = createProposalRecord({ cluster, replayCase, actorId, now });
          ledger.proposals.push(proposal);
          cluster = {
            ...cluster,
            latestProposalVersion: proposal.version,
            lastProposalFailureCount: cluster.failureCount,
          };
        }
        if (index >= 0) ledger.clusters[index] = cluster;
        else ledger.clusters.push(cluster);
        feedback = { ...feedback, cluster, proposal };
      } else if (observation.status === "pass") {
        const resolvedClusters: FailureClusterRecord[] = [];
        ledger.clusters = ledger.clusters.map((cluster) => {
          if (
            cluster.tenantId !== observation.tenantId ||
            cluster.caseId !== observation.caseId ||
            cluster.status !== "active"
          ) return cluster;
          const consecutivePasses = cluster.consecutivePasses + 1;
          const resolved = consecutivePasses >= FAILURE_RESOLUTION_PASS_THRESHOLD;
          const next: FailureClusterRecord = {
            ...cluster,
            status: resolved ? "resolved" : cluster.status,
            passCount: cluster.passCount + 1,
            consecutiveFailures: 0,
            consecutivePasses,
            latestEvalRunId: observation.evalRunId,
            latestResultId: observation.sourceResultId,
            lastSeenAt: now,
            resolvedAt: resolved ? now : cluster.resolvedAt,
            updatedAt: now,
          };
          if (resolved) resolvedClusters.push(next);
          return next;
        });
        feedback = { ...feedback, resolvedClusters };
      }
      return trimLedger(ledger);
    },
  );
  return feedback;
}

function createClusterRecord({
  observation,
  replayCase,
  fingerprint,
  now,
}: {
  observation: FailureObservationRecord;
  replayCase: MinimizedReplayCaseV1;
  fingerprint: string;
  now: string;
}): FailureClusterRecord {
  return {
    id: randomUUID(),
    tenantId: observation.tenantId,
    fingerprint,
    caseId: observation.caseId,
    caseType: observation.caseType,
    failureCategory: replayCase.failureCategory,
    status: "active",
    failureCount: 1,
    passCount: 0,
    consecutiveFailures: 1,
    consecutivePasses: 0,
    replayCase,
    replayCaseSha256: canonicalJsonSha256(replayCase),
    latestEvalRunId: observation.evalRunId,
    latestResultId: observation.sourceResultId,
    latestProposalVersion: 0,
    lastProposalFailureCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function createProposalRecord({
  cluster,
  replayCase,
  actorId,
  now,
}: {
  cluster: FailureClusterRecord;
  replayCase: MinimizedReplayCaseV1;
  actorId: string;
  now: string;
}): HarnessRuleProposalRecord {
  const proposal = buildHarnessRuleProposal(replayCase);
  return {
    id: randomUUID(),
    tenantId: cluster.tenantId,
    clusterId: cluster.id,
    version: cluster.latestProposalVersion + 1,
    kind: proposal.kind,
    target: proposal.target,
    proposal,
    proposalSha256: canonicalJsonSha256(proposal),
    status: "proposed",
    proposedBy: actorId,
    proposedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function shouldCreateProposal(
  cluster: FailureClusterRecord,
  latest?: HarnessRuleProposalRecord,
) {
  if (cluster.consecutiveFailures < RECURRING_FAILURE_THRESHOLD) return false;
  if (!latest) return true;
  if (latest.status !== "rejected") return false;
  return cluster.failureCount - cluster.lastProposalFailureCount >= RECURRING_FAILURE_THRESHOLD;
}

async function reviewDatabaseProposal({
  tenantId,
  proposalId,
  actorId,
  decision,
  reason,
  now,
}: {
  tenantId: string;
  proposalId: string;
  actorId: string;
  decision: "approved" | "rejected";
  reason: string;
  now: string;
}) {
  await ensureDatabaseSchema();
  const rows = await getSql()`
    UPDATE omni_harness_rule_proposals
    SET status = ${decision}, reviewed_by = ${actorId}, review_reason = ${reason},
        reviewed_at = ${now}, updated_at = ${now}
    WHERE tenant_id = ${tenantId}
      AND id = ${proposalId}
      AND status = 'proposed'
    RETURNING *
  `;
  if (rows[0]) return proposalFromRow(rows[0]);
  const existingRows = await getSql()`
    SELECT * FROM omni_harness_rule_proposals
    WHERE tenant_id = ${tenantId} AND id = ${proposalId}
    LIMIT 1
  `;
  const existing = existingRows[0] ? proposalFromRow(existingRows[0]) : undefined;
  if (
    existing?.status === decision &&
    existing.reviewedBy === actorId &&
    existing.reviewReason === reason
  ) return existing;
  throw new HarnessRuleReviewConflictError(
    existing ? "Harness rule proposal was already reviewed." : "Harness rule proposal was not found.",
  );
}

async function reviewFileProposal({
  tenantId,
  proposalId,
  actorId,
  decision,
  reason,
  now,
}: {
  tenantId: string;
  proposalId: string;
  actorId: string;
  decision: "approved" | "rejected";
  reason: string;
  now: string;
}) {
  let reviewed: HarnessRuleProposalRecord | undefined;
  let conflict: string | undefined;
  await updateJsonFile<FailureFeedbackLedger>(
    getFailureFeedbackFile(),
    emptyLedger(),
    (ledger) => {
      ledger.proposals = ledger.proposals.map((proposal) => {
        if (proposal.tenantId !== tenantId || proposal.id !== proposalId) return proposal;
        if (
          proposal.status === decision &&
          proposal.reviewedBy === actorId &&
          proposal.reviewReason === reason
        ) {
          reviewed = proposal;
          return proposal;
        }
        if (proposal.status !== "proposed") {
          conflict = "Harness rule proposal was already reviewed.";
          return proposal;
        }
        reviewed = {
          ...proposal,
          status: decision,
          reviewedBy: actorId,
          reviewReason: reason,
          reviewedAt: now,
          updatedAt: now,
        };
        return reviewed;
      });
      return ledger;
    },
  );
  if (conflict) throw new HarnessRuleReviewConflictError(conflict);
  if (!reviewed) throw new HarnessRuleReviewConflictError("Harness rule proposal was not found.");
  return reviewed;
}

async function recordFeedbackEvents(
  feedback: RecordEvaluationFeedbackResult,
  actorId: string,
) {
  const observation = feedback.observation;
  if (!observation) return;
  if (feedback.cluster) {
    await appendDomainEvent({
      id: `evaluation-failure-observed:${observation.sourceResultId}`,
      streamId: `evaluation:${observation.evalRunId}`,
      type: "evaluation.failure.observed",
      tenantId: observation.tenantId,
      actorId,
      correlationId: observation.evalRunId,
      causationId: observation.sourceResultId,
      payload: {
        schemaVersion: 1,
        caseId: observation.caseId,
        failureCategory: feedback.cluster.failureCategory,
        failureFingerprint: feedback.cluster.fingerprint,
        failureCount: feedback.cluster.failureCount,
        consecutiveFailures: feedback.cluster.consecutiveFailures,
        recurring: feedback.cluster.consecutiveFailures >= RECURRING_FAILURE_THRESHOLD,
        replayCaseSha256: feedback.cluster.replayCaseSha256,
      },
    });
  }
  if (feedback.proposal) {
    await appendDomainEvent({
      id: `harness-rule-proposed:${feedback.proposal.id}`,
      streamId: `harness-rule:${feedback.proposal.clusterId}`,
      type: "harness.rule.proposed",
      tenantId: feedback.proposal.tenantId,
      actorId,
      correlationId: feedback.proposal.clusterId,
      causationId: observation.sourceResultId,
      payload: {
        schemaVersion: 1,
        proposalId: feedback.proposal.id,
        proposalVersion: feedback.proposal.version,
        proposalSha256: feedback.proposal.proposalSha256,
        kind: feedback.proposal.kind,
        target: feedback.proposal.target,
        reviewRequired: true,
        automaticApplication: false,
      },
    });
  }
  for (const cluster of feedback.resolvedClusters) {
    await appendDomainEvent({
      id: `evaluation-failure-resolved:${observation.sourceResultId}:${cluster.id}`,
      streamId: `evaluation:${observation.evalRunId}`,
      type: "evaluation.failure.resolved",
      tenantId: observation.tenantId,
      actorId,
      correlationId: observation.evalRunId,
      causationId: observation.sourceResultId,
      payload: {
        schemaVersion: 1,
        caseId: cluster.caseId,
        failureFingerprint: cluster.fingerprint,
        failureCategory: cluster.failureCategory,
        consecutivePasses: cluster.consecutivePasses,
      },
    });
  }
}

async function syncFeedbackIncident(
  feedback: RecordEvaluationFeedbackResult,
  actorId: string,
) {
  const cluster = feedback.cluster;
  if (cluster?.consecutiveFailures && cluster.consecutiveFailures >= RECURRING_FAILURE_THRESHOLD) {
    await upsertIncidentFromSignal({
      tenantId: cluster.tenantId,
      fingerprint: incidentFingerprint(cluster.fingerprint),
      componentId: "evaluations",
      severity: "warning",
      title: `Recurring evaluation failure: ${cluster.caseId}`,
      message: "A minimized replay case and review-only harness rule proposal are available.",
      actorId,
      metadata: {
        failureFingerprint: cluster.fingerprint,
        failureCategory: cluster.failureCategory,
        caseId: cluster.caseId,
        failureCount: cluster.failureCount,
        consecutiveFailures: cluster.consecutiveFailures,
        replayCaseSha256: cluster.replayCaseSha256,
      },
      playbookIds: ["evaluations.run_regression"],
    });
  }
  for (const resolved of feedback.resolvedClusters) {
    await resolveIncidentByFingerprint(incidentFingerprint(resolved.fingerprint), {
      tenantId: resolved.tenantId,
      actorId,
      resolution: "Two consecutive focused evaluation passes resolved the recurring category.",
      metadata: {
        failureFingerprint: resolved.fingerprint,
        consecutivePasses: resolved.consecutivePasses,
      },
    });
  }
}

function incidentFingerprint(clusterFingerprint: string) {
  return `evaluation.recurring:${clusterFingerprint}`;
}

function summarizeFeedback(
  clusters: FailureClusterRecord[],
  proposals: HarnessRuleProposalRecord[],
  observations: number,
) {
  const byCategory: Record<string, number> = {};
  for (const cluster of clusters) {
    byCategory[cluster.failureCategory] =
      (byCategory[cluster.failureCategory] || 0) + cluster.failureCount;
  }
  return {
    observations,
    activeClusters: clusters.filter((item) => item.status === "active").length,
    activeRecurring: clusters.filter((item) =>
      item.status === "active" && item.consecutiveFailures >= RECURRING_FAILURE_THRESHOLD
    ).length,
    resolvedClusters: clusters.filter((item) => item.status === "resolved").length,
    proposedRules: proposals.filter((item) => item.status === "proposed").length,
    approvedRules: proposals.filter((item) => item.status === "approved").length,
    rejectedRules: proposals.filter((item) => item.status === "rejected").length,
    byCategory,
  };
}

function clusterFromRow(row: Record<string, unknown>): FailureClusterRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    fingerprint: String(row.fingerprint),
    caseId: String(row.case_id),
    caseType: String(row.case_type) as EvalCaseDefinition["type"],
    failureCategory: String(row.failure_category) as EvaluationFailureCategory,
    status: String(row.status) as FailureClusterStatus,
    failureCount: Number(row.failure_count || 0),
    passCount: Number(row.pass_count || 0),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    consecutivePasses: Number(row.consecutive_passes || 0),
    replayCase: parseObject(row.replay_case) as MinimizedReplayCaseV1,
    replayCaseSha256: String(row.replay_case_sha256),
    latestEvalRunId: String(row.latest_eval_run_id),
    latestResultId: String(row.latest_result_id),
    latestProposalVersion: Number(row.latest_proposal_version || 0),
    lastProposalFailureCount: Number(row.last_proposal_failure_count || 0),
    firstSeenAt: normalizeDate(row.first_seen_at),
    lastSeenAt: normalizeDate(row.last_seen_at),
    resolvedAt: row.resolved_at ? normalizeDate(row.resolved_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function proposalFromRow(row: Record<string, unknown>): HarnessRuleProposalRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    clusterId: String(row.cluster_id),
    version: Number(row.version),
    kind: String(row.kind) as HarnessRuleKind,
    target: String(row.target),
    proposal: parseObject(row.proposal) as HarnessRuleProposalV1,
    proposalSha256: String(row.proposal_sha256),
    status: String(row.status) as HarnessRuleProposalStatus,
    proposedBy: String(row.proposed_by),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewReason: row.review_reason ? String(row.review_reason) : undefined,
    proposedAt: normalizeDate(row.proposed_at),
    reviewedAt: row.reviewed_at ? normalizeDate(row.reviewed_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function normalizeActorId(value?: string) {
  return (value || "evaluation-harness").trim().slice(0, 240) || "evaluation-harness";
}

function emptyLedger(): FailureFeedbackLedger {
  return { observations: [], clusters: [], proposals: [] };
}

async function readFailureFeedbackLedger() {
  return readJsonFile<FailureFeedbackLedger>(getFailureFeedbackFile(), emptyLedger());
}

function trimLedger(ledger: FailureFeedbackLedger): FailureFeedbackLedger {
  return {
    observations: ledger.observations.slice(-5_000),
    clusters: ledger.clusters.slice(-500),
    proposals: ledger.proposals.slice(-1_000),
  };
}

function getFailureFeedbackFile() {
  return getDataPath("evaluation-failure-feedback.json");
}
