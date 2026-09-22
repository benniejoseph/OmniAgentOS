import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  parseDataInfluenceManifestV1,
  type DataInfluenceManifestV1,
} from "@/lib/security/data-influence";
import {
  buildPolicyLeaseV1,
  consumePolicyLeaseV1,
  parsePolicyLeaseV1,
  policyLeaseConsumptionV1Schema,
  type PolicyLeasePrincipalBindingV1,
  type PolicyLeaseV1,
} from "@/lib/security/policy-lease";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type {
  WorkflowScheduleMutationBindingV1,
  WorkflowScheduleMutationPolicyV1,
} from "@/lib/workflows/types";

export const SCHEDULED_POLICY_LEASE_TTL_MS = 5 * 60_000;

type SqlClient = ReturnType<typeof getSql>;

export type ScheduledPolicyLeaseAuthority = Readonly<{
  tenantId: string;
  ownerActorId: string;
  triggerId: string;
  occurrenceId: string;
  workflowRunId: string;
  scheduleConfigurationSha256: string;
  occurrenceAuthoritySha256: string;
  reviewedSnapshotSha256: string;
  mutationPolicySha256: string;
  bindingIndex: number;
  toolContractSha256: string;
  bindingSha256: string;
}>;

export type ScheduledPolicyLeaseClaim = Readonly<{
  lease: PolicyLeaseV1;
  authority: ScheduledPolicyLeaseAuthority;
  influenceManifest: DataInfluenceManifestV1;
}>;

export class PolicyLeaseStoreError extends Error {
  constructor(
    public readonly code:
      | "unavailable"
      | "binding_mismatch"
      | "inactive_schedule"
      | "already_consumed"
      | "expired",
    message: string,
  ) {
    super(message);
    this.name = "PolicyLeaseStoreError";
  }
}

export async function issueScheduledPolicyLease(input: {
  authority: ScheduledPolicyLeaseAuthority;
  executionId: string;
  toolId: string;
  inputSha256: string;
  targetSha256: string;
  principal: PolicyLeasePrincipalBindingV1;
  influenceManifest: DataInfluenceManifestV1;
  executionScope: ExecutionScope;
  now?: string;
}): Promise<ScheduledPolicyLeaseClaim> {
  if (!hasDatabaseUrl()) {
    throw new PolicyLeaseStoreError(
      "unavailable",
      "Scheduled mutation leases require durable database storage.",
    );
  }
  const authority = normalizeAuthority(input.authority);
  assertActorScope(input.executionScope, authority);
  const issuedAt = canonicalTimestamp(input.now || new Date().toISOString());
  const influenceManifest = parseDataInfluenceManifestV1(
    input.influenceManifest,
  );
  if (
    influenceManifest.tenantId !== authority.tenantId ||
    influenceManifest.runId !== authority.workflowRunId ||
    influenceManifest.executionId !== input.executionId ||
    influenceManifest.principalId !== input.principal.id ||
    input.principal.kind !== "agent" ||
    input.executionScope.executingPrincipalType !== input.principal.kind ||
    input.executionScope.executingPrincipalId !== input.principal.id
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Data-influence manifest does not match the scheduled effect context.",
    );
  }
  assertScheduledInfluenceManifest(
    influenceManifest,
    authority,
    input.principal.id,
  );
  const lease = buildPolicyLeaseV1({
    executionId: requiredId(input.executionId, "execution"),
    toolId: requiredId(input.toolId, "tool"),
    inputSha256: sha256(input.inputSha256, "input"),
    targetSha256: sha256(input.targetSha256, "target"),
    principal: input.principal,
    policySha256: authority.mutationPolicySha256,
    influenceManifestSha256: influenceManifest.manifestSha256,
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + SCHEDULED_POLICY_LEASE_TTL_MS,
    ).toISOString(),
  });

  return runWithDatabaseActorScope(
    authority.tenantId,
    [authority.ownerActorId],
    async () => {
      await ensureDatabaseSchema();
      return getSql().transaction(async (sql: SqlClient) => {
        const schedule = await readLiveScheduleAuthority(sql, authority);
        assertMutationBinding(schedule, authority, lease);
        const priorRows = await sql`
          SELECT lease_payload, state
          FROM omni_policy_leases
          WHERE tenant_id = ${authority.tenantId}
            AND owner_actor_id = ${authority.ownerActorId}
            AND execution_id = ${lease.executionId}
          FOR UPDATE
        `;
        if (priorRows[0]) {
          const prior = parsePolicyLeaseV1(priorRows[0].lease_payload);
          if (
            prior.toolId !== lease.toolId ||
            prior.inputSha256 !== lease.inputSha256 ||
            prior.targetSha256 !== lease.targetSha256 ||
            prior.principal.id !== lease.principal.id ||
            prior.principal.generation !== lease.principal.generation ||
            prior.policySha256 !== lease.policySha256 ||
            prior.influenceManifestSha256 !== lease.influenceManifestSha256 ||
            String(priorRows[0].state) !== "active" ||
            Date.parse(prior.expiresAt) <= Date.now()
          ) {
            throw new PolicyLeaseStoreError(
              "binding_mismatch",
              "A prior lease for this effect cannot be rebound or replayed.",
            );
          }
          assertMutationBinding(schedule, authority, prior);
          return Object.freeze({ lease: prior, authority, influenceManifest });
        }
        const inserted = await sql`
          INSERT INTO omni_policy_leases (
            schema_version, tenant_id, owner_actor_id, lease_id,
            lease_sha256, trigger_id, occurrence_id, workflow_run_id,
            schedule_configuration_sha256, occurrence_authority_sha256,
            reviewed_snapshot_sha256, mutation_policy_sha256,
            binding_index, binding_sha256, tool_contract_sha256,
            tool_id, input_sha256, target_sha256, execution_id,
            principal_id, principal_generation, influence_manifest_sha256,
            lease_payload, state, issued_at, expires_at
          ) VALUES (
            1, ${authority.tenantId}, ${authority.ownerActorId}, ${lease.leaseId},
            ${lease.leaseSha256}, ${authority.triggerId}, ${authority.occurrenceId},
            ${authority.workflowRunId}, ${authority.scheduleConfigurationSha256},
            ${authority.occurrenceAuthoritySha256},
            ${authority.reviewedSnapshotSha256}, ${authority.mutationPolicySha256},
            ${authority.bindingIndex}, ${authority.bindingSha256},
            ${authority.toolContractSha256}, ${lease.toolId}, ${lease.inputSha256},
            ${lease.targetSha256}, ${lease.executionId}, ${lease.principal.id},
            ${lease.principal.generation}, ${lease.influenceManifestSha256},
            ${lease}::jsonb, 'active', ${lease.issuedAt}, ${lease.expiresAt}
          )
          ON CONFLICT (tenant_id, owner_actor_id, lease_id) DO NOTHING
          RETURNING lease_payload
        `;
        if (!inserted[0]) {
          const rows = await sql`
            SELECT lease_payload FROM omni_policy_leases
            WHERE tenant_id = ${authority.tenantId}
              AND owner_actor_id = ${authority.ownerActorId}
              AND lease_id = ${lease.leaseId}
            FOR UPDATE
          `;
          const existing = rows[0]
            ? parsePolicyLeaseV1(rows[0].lease_payload)
            : undefined;
          if (!existing || existing.leaseSha256 !== lease.leaseSha256) {
            throw new PolicyLeaseStoreError(
              "binding_mismatch",
              "Policy lease identity conflicts with another binding.",
            );
          }
          return Object.freeze({ lease: existing, authority, influenceManifest });
        }
        await appendLeaseEvent("issued", lease, authority, input.executionScope, sql);
        return Object.freeze({ lease, authority, influenceManifest });
      }) as Promise<ScheduledPolicyLeaseClaim>;
    },
  );
}

/**
 * Consumes a lease inside the caller's governed tool-claim transaction. The
 * lease is evidence for a separately reviewed standing schedule; it does not
 * grant authority by itself.
 */
export async function consumeScheduledPolicyLeaseForEffectClaim(
  input: {
    claim: ScheduledPolicyLeaseClaim;
    executionId: string;
    toolId: string;
    inputSha256: string;
    targetSha256: string;
    influenceManifest: DataInfluenceManifestV1;
    executionScope: ExecutionScope;
    consumedAt?: string;
  },
  sql: SqlClient,
) {
  const authority = normalizeAuthority(input.claim.authority);
  assertActorScope(input.executionScope, authority);
  const lease = parsePolicyLeaseV1(input.claim.lease);
  const influenceManifest = parseDataInfluenceManifestV1(
    input.influenceManifest,
  );
  const livePrincipalId = input.executionScope.executingPrincipalId?.trim();
  if (
    influenceManifest.tenantId !== authority.tenantId ||
    influenceManifest.runId !== authority.workflowRunId ||
    influenceManifest.executionId !== input.executionId ||
    input.executionScope.executingPrincipalType !== "agent" ||
    !livePrincipalId ||
    influenceManifest.principalId !== livePrincipalId ||
    influenceManifest.manifestSha256 !== lease.influenceManifestSha256 ||
    input.claim.influenceManifest.manifestSha256 !==
      influenceManifest.manifestSha256
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Live effect principal or influence manifest changed after lease issue.",
    );
  }
  const rows = await sql`
    SELECT lease_payload, state, consumed_at
    FROM omni_policy_leases
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${authority.ownerActorId}
      AND lease_id = ${lease.leaseId}
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new PolicyLeaseStoreError("unavailable", "Policy lease is unavailable.");
  }
  const storedLease = parsePolicyLeaseV1(rows[0].lease_payload);
  if (storedLease.leaseSha256 !== lease.leaseSha256) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Policy lease payload changed after issue.",
    );
  }
  if (String(rows[0].state) !== "active") {
    throw new PolicyLeaseStoreError(
      "already_consumed",
      "Policy lease has already been consumed.",
    );
  }
  const schedule = await readLiveScheduleAuthority(sql, authority);
  assertMutationBinding(schedule, authority, storedLease);
  const livePrincipal: PolicyLeasePrincipalBindingV1 = Object.freeze({
    kind: "agent",
    id: livePrincipalId,
    // The generation is read from the currently locked schedule identity pin,
    // never copied from the presented lease.
    generation: schedule.agentPrincipalGeneration,
  });
  assertScheduledInfluenceManifest(
    influenceManifest,
    authority,
    livePrincipal.id,
  );
  let receipt;
  try {
    receipt = consumePolicyLeaseV1({
      lease: storedLease,
      attempt: {
        executionId: requiredId(input.executionId, "execution"),
        toolId: requiredId(input.toolId, "tool"),
        inputSha256: sha256(input.inputSha256, "input"),
        targetSha256: sha256(input.targetSha256, "target"),
        principal: livePrincipal,
        policySha256: authority.mutationPolicySha256,
        influenceManifestSha256: influenceManifest.manifestSha256,
        consumedAt: canonicalTimestamp(input.consumedAt || new Date().toISOString()),
      },
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error && error.code === "expired"
      ? "expired"
      : "binding_mismatch";
    throw new PolicyLeaseStoreError(code, "Policy lease no longer matches this effect claim.");
  }
  const parsedReceipt = policyLeaseConsumptionV1Schema.parse(receipt);
  await sql`
    INSERT INTO omni_policy_lease_consumptions (
      schema_version, tenant_id, owner_actor_id, receipt_id,
      receipt_sha256, lease_id, lease_sha256, trigger_id, occurrence_id,
      workflow_run_id, execution_id, binding_sha256,
      consumption_payload, consumed_at
    ) VALUES (
      1, ${authority.tenantId}, ${authority.ownerActorId},
      ${`policy_lease_receipt_${parsedReceipt.receiptSha256.slice(0, 48)}`},
      ${parsedReceipt.receiptSha256}, ${parsedReceipt.leaseId},
      ${parsedReceipt.leaseSha256}, ${authority.triggerId},
      ${authority.occurrenceId}, ${authority.workflowRunId},
      ${parsedReceipt.executionId}, ${parsedReceipt.bindingSha256},
      ${parsedReceipt}::jsonb, ${parsedReceipt.consumedAt}
    )
  `;
  const updated = await sql`
    UPDATE omni_policy_leases
    SET state = 'consumed', consumed_at = ${parsedReceipt.consumedAt},
        consumption_receipt_sha256 = ${parsedReceipt.receiptSha256}
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${authority.ownerActorId}
      AND lease_id = ${lease.leaseId}
      AND state = 'active'
    RETURNING lease_id
  `;
  if (!updated[0]) {
    throw new PolicyLeaseStoreError(
      "already_consumed",
      "Policy lease was consumed by another effect claim.",
    );
  }
  await appendLeaseEvent(
    "consumed",
    storedLease,
    authority,
    input.executionScope,
    sql,
    parsedReceipt.receiptSha256,
  );
  return parsedReceipt;
}

function assertMutationBinding(
  schedule: Readonly<{
    policy: WorkflowScheduleMutationPolicyV1;
    agentPrincipalId: string;
    agentPrincipalGeneration: number;
    agentIdentityPinSha256: string;
    agentPolicyPinSha256: string;
  }>,
  authority: ScheduledPolicyLeaseAuthority,
  lease: PolicyLeaseV1,
) {
  const policy = schedule.policy;
  if (
    policy.policySha256 !== authority.mutationPolicySha256 ||
    policy.procedureSnapshotSha256.length !== 64 ||
    policy.agentIdentityPinSha256 !== schedule.agentIdentityPinSha256 ||
    policy.agentPolicyPinSha256 !== schedule.agentPolicyPinSha256 ||
    lease.principal.kind !== "agent" ||
    lease.principal.id !== schedule.agentPrincipalId ||
    lease.principal.generation !== schedule.agentPrincipalGeneration
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "The reviewed mutation policy changed.",
    );
  }
  const binding = policy.bindings.find(
    (candidate) => candidate.bindingIndex === authority.bindingIndex,
  );
  if (
    !binding ||
    binding.bindingSha256 !== authority.bindingSha256 ||
    binding.toolContractSha256 !== authority.toolContractSha256 ||
    binding.toolId !== lease.toolId ||
    binding.inputSha256 !== lease.inputSha256 ||
    binding.targetSha256 !== lease.targetSha256
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "The current tool effect does not match the reviewed static binding.",
    );
  }
}

async function readLiveScheduleAuthority(
  sql: SqlClient,
  authority: ScheduledPolicyLeaseAuthority,
) {
  const rows = await sql`
    SELECT trigger.status AS trigger_status,
           trigger.replaced_by_trigger_id,
           trigger.schedule_config,
           trigger.schedule_config_sha256,
           occurrence.status AS occurrence_status,
           occurrence.workflow_run_id,
           occurrence.authority_sha256,
           occurrence.reviewed_snapshot_sha256
    FROM omni_workflow_schedule_occurrences occurrence
    JOIN omni_workflow_triggers trigger
      ON trigger.tenant_id = occurrence.tenant_id
     AND trigger.id = occurrence.trigger_id
    WHERE occurrence.tenant_id = ${authority.tenantId}
      AND occurrence.owner_actor_id = ${authority.ownerActorId}
      AND occurrence.id = ${authority.occurrenceId}
      AND occurrence.trigger_id = ${authority.triggerId}
    FOR UPDATE OF occurrence, trigger
  `;
  const row = rows[0];
  if (!row) {
    throw new PolicyLeaseStoreError(
      "unavailable",
      "The scheduled occurrence authority is unavailable.",
    );
  }
  if (
    String(row.trigger_status) !== "active" ||
    row.replaced_by_trigger_id !== null ||
    String(row.occurrence_status) !== "enqueued"
  ) {
    throw new PolicyLeaseStoreError(
      "inactive_schedule",
      "The schedule is paused, replaced, or no longer executable.",
    );
  }
  if (
    String(row.workflow_run_id) !== authority.workflowRunId ||
    String(row.schedule_config_sha256) !== authority.scheduleConfigurationSha256 ||
    String(row.authority_sha256) !== authority.occurrenceAuthoritySha256 ||
    String(row.reviewed_snapshot_sha256) !== authority.reviewedSnapshotSha256
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "The scheduled occurrence no longer matches its reviewed authority.",
    );
  }
  const config = objectValue(row.schedule_config);
  const policy = parseMutationPolicy(config.mutationPolicy);
  const identityPin = objectValue(config.agentIdentityPin);
  return {
    policy,
    agentPrincipalId: requiredId(
      String(identityPin.principalId || ""),
      "Agent principal",
    ),
    agentPrincipalGeneration: positiveGeneration(
      identityPin.principalGeneration,
    ),
    agentIdentityPinSha256: sha256(
      String(identityPin.pinSha256 || ""),
      "Agent identity pin",
    ),
    agentPolicyPinSha256: sha256(
      String(config.policyPinSha256 || ""),
      "Agent policy pin",
    ),
  };
}

function assertScheduledInfluenceManifest(
  manifest: DataInfluenceManifestV1,
  authority: ScheduledPolicyLeaseAuthority,
  principalId: string,
) {
  const authorityReference = manifest.authorityReferences[0];
  const modelInfluence = manifest.untrustedInfluences[0];
  if (
    manifest.principalId !== principalId ||
    manifest.authorityReferences.length !== 1 ||
    !authorityReference ||
    authorityReference.kind !== "standing_grant" ||
    authorityReference.referenceId !== authority.triggerId ||
    authorityReference.evidenceSha256 !== authority.mutationPolicySha256 ||
    manifest.untrustedInfluences.length !== 1 ||
    !modelInfluence ||
    modelInfluence.kind !== "model" ||
    modelInfluence.referenceId !==
      `workflow-plan-node:${modelInfluence.contentSha256.slice(0, 48)}`
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "The live plan influence no longer matches the reviewed schedule effect.",
    );
  }
}

export function parseMutationPolicy(value: unknown): WorkflowScheduleMutationPolicyV1 {
  const candidate = objectValue(value);
  const bindings = Array.isArray(candidate.bindings)
    ? candidate.bindings.map(parseMutationBinding)
    : [];
  const body = {
    schemaVersion: 1 as const,
    policyKind: "reviewed_static_mutation" as const,
    procedureSnapshotSha256: sha256(
      String(candidate.procedureSnapshotSha256 || ""),
      "procedure snapshot",
    ),
    agentIdentityPinSha256: sha256(
      String(candidate.agentIdentityPinSha256 || ""),
      "Agent identity pin",
    ),
    agentPolicyPinSha256: sha256(
      String(candidate.agentPolicyPinSha256 || ""),
      "Agent policy pin",
    ),
    occurrenceBudgetSha256: sha256(
      String(candidate.occurrenceBudgetSha256 || ""),
      "occurrence budget",
    ),
    maximumOccurrences: boundedInteger(candidate.maximumOccurrences),
    bindings: Object.freeze(bindings),
  };
  const policySha256 = sha256(
    String(candidate.policySha256 || ""),
    "mutation policy",
  );
  if (
    candidate.schemaVersion !== 1 ||
    candidate.policyKind !== "reviewed_static_mutation" ||
    !bindings.length ||
    canonicalJsonSha256(body) !== policySha256
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Scheduled mutation policy digest is invalid.",
    );
  }
  return Object.freeze({ ...body, policySha256 });
}

function parseMutationBinding(value: unknown): WorkflowScheduleMutationBindingV1 {
  const candidate = objectValue(value);
  const body = {
    schemaVersion: 1 as const,
    bindingIndex: boundedIndex(candidate.bindingIndex),
    toolId: requiredId(String(candidate.toolId || ""), "tool"),
    inputSha256: sha256(String(candidate.inputSha256 || ""), "input"),
    targetSha256: sha256(String(candidate.targetSha256 || ""), "target"),
    toolContractSha256: sha256(
      String(candidate.toolContractSha256 || ""),
      "tool contract",
    ),
    riskLevel: candidate.riskLevel as 1 | 2,
    reversible: true as const,
  };
  const bindingSha256 = sha256(
    String(candidate.bindingSha256 || ""),
    "mutation binding",
  );
  if (
    candidate.schemaVersion !== 1 ||
    (body.riskLevel !== 1 && body.riskLevel !== 2) ||
    candidate.reversible !== true ||
    canonicalJsonSha256(body) !== bindingSha256
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Scheduled mutation binding digest is invalid.",
    );
  }
  return Object.freeze({ ...body, bindingSha256 });
}

function normalizeAuthority(
  value: ScheduledPolicyLeaseAuthority,
): ScheduledPolicyLeaseAuthority {
  return Object.freeze({
    tenantId: requiredId(value.tenantId, "tenant"),
    ownerActorId: requiredId(value.ownerActorId, "owner actor"),
    triggerId: requiredId(value.triggerId, "trigger"),
    occurrenceId: requiredId(value.occurrenceId, "occurrence"),
    workflowRunId: requiredId(value.workflowRunId, "workflow run"),
    scheduleConfigurationSha256: sha256(
      value.scheduleConfigurationSha256,
      "schedule configuration",
    ),
    occurrenceAuthoritySha256: sha256(
      value.occurrenceAuthoritySha256,
      "occurrence authority",
    ),
    reviewedSnapshotSha256: sha256(
      value.reviewedSnapshotSha256,
      "reviewed snapshot",
    ),
    mutationPolicySha256: sha256(
      value.mutationPolicySha256,
      "mutation policy",
    ),
    bindingIndex: boundedIndex(value.bindingIndex),
    toolContractSha256: sha256(value.toolContractSha256, "tool contract"),
    bindingSha256: sha256(value.bindingSha256, "binding"),
  });
}

function assertActorScope(
  scope: ExecutionScope,
  authority: ScheduledPolicyLeaseAuthority,
) {
  assertExecutionScopeTenant(scope, authority.tenantId);
  if (scope.initiatingActorId !== authority.ownerActorId) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Policy lease owner does not match the initiating actor.",
    );
  }
}

async function appendLeaseEvent(
  action: "issued" | "consumed",
  lease: PolicyLeaseV1,
  authority: ScheduledPolicyLeaseAuthority,
  executionScope: ExecutionScope,
  sql: SqlClient,
  consumptionReceiptSha256?: string,
) {
  const payload = {
    schemaVersion: 1,
    action,
    leaseId: lease.leaseId,
    leaseSha256: lease.leaseSha256,
    triggerId: authority.triggerId,
    occurrenceId: authority.occurrenceId,
    workflowRunId: authority.workflowRunId,
    mutationPolicySha256: authority.mutationPolicySha256,
    bindingSha256: authority.bindingSha256,
    executionId: lease.executionId,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    ...(consumptionReceiptSha256 ? { consumptionReceiptSha256 } : {}),
    leaseGrantsAuthority: false,
  };
  await appendScopedDomainEvent({
    id: `policy-lease:${canonicalJsonSha256(payload)}`,
    streamId: `workflow-schedule:${authority.triggerId}`,
    type: `security.policy_lease.${action}`,
    executionScope: deriveExecutionScope(executionScope, {
      causationId: `workflow-schedule-occurrence:${authority.occurrenceId}`,
      purpose: `security.policy_lease.${action}`,
    }),
    payload,
  }, { sql });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyLeaseStoreError("binding_mismatch", "Expected an immutable object binding.");
  }
  return value as Record<string, unknown>;
}

function sha256(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      `Policy lease ${label} digest is invalid.`,
    );
  }
  return normalized;
}

function requiredId(value: string, label: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      `Policy lease ${label} ID is invalid.`,
    );
  }
  return normalized;
}

function canonicalTimestamp(value: string) {
  const timestamp = new Date(value).toISOString();
  if (timestamp !== value) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Policy lease timestamps must use canonical UTC form.",
    );
  }
  return timestamp;
}

function boundedInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Scheduled mutation maximum occurrences are invalid.",
    );
  }
  return parsed;
}

function boundedIndex(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 11) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Scheduled mutation binding index is invalid.",
    );
  }
  return parsed;
}

function positiveGeneration(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PolicyLeaseStoreError(
      "binding_mismatch",
      "Scheduled Agent principal generation is invalid.",
    );
  }
  return parsed;
}
