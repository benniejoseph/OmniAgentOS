import "server-only";

import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { listFileAiUsageRecords } from "@/lib/usage/ledger";
import type {
  ModelAssignmentRuntimeReceipt,
  RequestModelAssignment,
} from "@/lib/settings/types";

export async function listModelAssignmentRuntimeReceipts(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  assignments: readonly RequestModelAssignment[];
}): Promise<ModelAssignmentRuntimeReceipt[]> {
  const assignments = input.assignments.filter((assignment) =>
    assignment.manageable &&
    assignment.runtimeReadiness === "active" &&
    assignment.contractVersion === "p11.8-model-assignment:1" &&
    assignment.configurationSha256 &&
    assignment.validatedAt
  );
  if (!assignments.length) return [];
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const actorIds = input.requestActorBinding?.readableOwnerActorIds?.length
    ? input.requestActorBinding.readableOwnerActorIds
    : [input.actorId];
  const rows = hasDatabaseUrl()
    ? await listPostgresRows(input.tenantId, actorIds)
    : await listFileAiUsageRecords({ tenantId: input.tenantId, limit: 1_000 });
  const receipts = new Map<string, ModelAssignmentRuntimeReceipt>();
  for (const row of rows) {
    const assignmentId = textField(row, "assignment_id", "assignmentId");
    const assignment = assignmentId ? assignmentById.get(assignmentId) : undefined;
    if (!assignment || receipts.has(assignment.scope)) continue;
    const actorId = textField(row, "actor_id", "actorId");
    const scope = textField(row, "assignment_scope", "assignmentScope");
    const revision = numberField(row, "assignment_revision", "assignmentRevision");
    const sha256 = textField(
      row,
      "assignment_configuration_sha256",
      "assignmentConfigurationSha256",
    );
    const credentialSource = textField(row, "credential_source", "credentialSource");
    if (
      !actorId || !actorIds.includes(actorId) ||
      scope !== assignment.scope ||
      revision !== assignment.revision ||
      sha256 !== assignment.configurationSha256 ||
      credentialSource !== "tenant_vault"
    ) continue;
    const status = textField(row, "status", "status");
    const provider = textField(row, "provider", "provider");
    const model = textField(row, "model", "model");
    const recordedAt = dateField(row, "recorded_at", "recordedAt");
    if (
      (status !== "completed" && status !== "failed") ||
      !provider || !model || !recordedAt ||
      !sha256 || !/^[a-f0-9]{64}$/.test(sha256)
    ) continue;
    const callReceipts = arrayField(row, "call_receipts", "callReceipts");
    receipts.set(assignment.scope, {
      scope: assignment.scope,
      assignmentId: assignment.id,
      assignmentRevision: revision,
      assignmentConfigurationSha256: sha256,
      state: status === "completed" ? "succeeded" : "failed",
      provider,
      model,
      fallbackUsed: callReceipts.length > 1 ||
        provider !== assignment.provider || model !== assignment.modelId,
      credentialSource: "tenant_vault",
      recordedAt,
    });
  }
  return [...receipts.values()].sort((left, right) =>
    left.scope.localeCompare(right.scope)
  );
}

async function listPostgresRows(tenantId: string, actorIds: readonly string[]) {
  await ensureDatabaseSchema();
  const [firstActorId, secondActorId = firstActorId] = actorIds;
  return getSql()`
    SELECT actor_id, assignment_id, assignment_scope, assignment_revision,
      assignment_configuration_sha256, status, provider, model,
      credential_source, call_receipts, recorded_at
    FROM omni_ai_usage
    WHERE tenant_id = ${tenantId}
      AND actor_id IN (${firstActorId}, ${secondActorId})
      AND assignment_id IS NOT NULL
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1000
  `;
}

function textField(
  row: Record<string, unknown>,
  databaseKey: string,
  fileKey: string,
) {
  const value = row[databaseKey] ?? row[fileKey];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  row: Record<string, unknown>,
  databaseKey: string,
  fileKey: string,
) {
  const value = Number(row[databaseKey] ?? row[fileKey]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function dateField(
  row: Record<string, unknown>,
  databaseKey: string,
  fileKey: string,
) {
  const value = row[databaseKey] ?? row[fileKey];
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function arrayField(
  row: Record<string, unknown>,
  databaseKey: string,
  fileKey: string,
) {
  const value = row[databaseKey] ?? row[fileKey];
  return Array.isArray(value) ? value : [];
}
