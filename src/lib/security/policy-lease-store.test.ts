import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildDataInfluenceManifestV1 } from "@/lib/security/data-influence";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildPolicyLeaseV1 } from "@/lib/security/policy-lease";
import {
  consumeScheduledPolicyLeaseForEffectClaim,
  PolicyLeaseStoreError,
  type ScheduledPolicyLeaseAuthority,
  type ScheduledPolicyLeaseClaim,
} from "@/lib/security/policy-lease-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type {
  WorkflowScheduleMutationBindingV1,
  WorkflowScheduleMutationPolicyV1,
} from "@/lib/workflows/types";

const tenantId = "tenant:policy-lease-store";
const actorId = "actor:policy-lease-owner";
const principalId = "agent:scheduled-policy:g1";
const inputSha256 = "1".repeat(64);
const targetSha256 = "2".repeat(64);
const toolContractSha256 = "3".repeat(64);

function fixture(input: {
  scheduleGeneration?: number;
  manifestContentSha256?: string;
} = {}) {
  const bindingBody = {
    schemaVersion: 1 as const,
    bindingIndex: 0,
    toolId: "calendar.create",
    inputSha256,
    targetSha256,
    toolContractSha256,
    riskLevel: 2 as const,
    reversible: true as const,
  };
  const binding: WorkflowScheduleMutationBindingV1 = Object.freeze({
    ...bindingBody,
    bindingSha256: canonicalJsonSha256(bindingBody),
  });
  const policyBody = {
    schemaVersion: 1 as const,
    policyKind: "reviewed_static_mutation" as const,
    procedureSnapshotSha256: "4".repeat(64),
    agentIdentityPinSha256: "5".repeat(64),
    agentPolicyPinSha256: "6".repeat(64),
    occurrenceBudgetSha256: "7".repeat(64),
    maximumOccurrences: 12,
    bindings: [binding],
  };
  const policy: WorkflowScheduleMutationPolicyV1 = Object.freeze({
    ...policyBody,
    policySha256: canonicalJsonSha256(policyBody),
  });
  const authority: ScheduledPolicyLeaseAuthority = Object.freeze({
    tenantId,
    ownerActorId: actorId,
    triggerId: "trigger:policy-lease",
    occurrenceId: "occurrence:policy-lease",
    workflowRunId: "workflow-run-policy-lease",
    scheduleConfigurationSha256: "8".repeat(64),
    occurrenceAuthoritySha256: "9".repeat(64),
    reviewedSnapshotSha256: "a".repeat(64),
    mutationPolicySha256: policy.policySha256,
    bindingIndex: binding.bindingIndex,
    toolContractSha256,
    bindingSha256: binding.bindingSha256,
  });
  const executionId = "idem_" + "b".repeat(64);
  const modelInfluenceSha256 = input.manifestContentSha256 || "c".repeat(64);
  const influenceManifest = buildDataInfluenceManifestV1({
    tenantId,
    runId: authority.workflowRunId,
    executionId,
    principalId,
    createdAt: "2026-09-22T10:00:00.000Z",
    authorityReferences: [{
      kind: "standing_grant",
      referenceId: authority.triggerId,
      evidenceSha256: authority.mutationPolicySha256,
    }],
    untrustedInfluences: [{
      kind: "model",
      referenceId: `workflow-plan-node:${modelInfluenceSha256.slice(0, 48)}`,
      contentSha256: modelInfluenceSha256,
    }],
  });
  const lease = buildPolicyLeaseV1({
    executionId,
    toolId: binding.toolId,
    inputSha256,
    targetSha256,
    principal: { kind: "agent", id: principalId, generation: 7 },
    policySha256: policy.policySha256,
    influenceManifestSha256: influenceManifest.manifestSha256,
    issuedAt: "2026-09-22T10:00:00.000Z",
    expiresAt: "2026-09-22T10:05:00.000Z",
  });
  const claim: ScheduledPolicyLeaseClaim = Object.freeze({
    lease,
    authority,
    influenceManifest,
  });
  const executionScope = createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: principalId,
    correlationId: authority.occurrenceId,
    purpose: "workflow.node.tool.execute",
  });
  const statements: string[] = [];
  const sql = async (
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const statement = strings.join("?");
    statements.push(statement);
    if (statement.includes("FROM omni_policy_leases")) {
      return [{ lease_payload: lease, state: "active", consumed_at: null }];
    }
    if (statement.includes("FROM omni_workflow_schedule_occurrences")) {
      return [{
        trigger_status: "active",
        replaced_by_trigger_id: null,
        schedule_config: {
          mutationPolicy: policy,
          agentIdentityPin: {
            principalId,
            principalGeneration: input.scheduleGeneration || 7,
            pinSha256: policy.agentIdentityPinSha256,
          },
          policyPinSha256: policy.agentPolicyPinSha256,
        },
        schedule_config_sha256: authority.scheduleConfigurationSha256,
        occurrence_status: "enqueued",
        workflow_run_id: authority.workflowRunId,
        authority_sha256: authority.occurrenceAuthoritySha256,
        reviewed_snapshot_sha256: authority.reviewedSnapshotSha256,
      }];
    }
    return [];
  };
  return { authority, claim, executionScope, policy, statements, sql };
}

describe("scheduled PolicyLease durable binding", () => {
  it("rejects a different live effect principal before any durable mutation", async () => {
    const value = fixture();
    const wrongScope = createExecutionScope({
      ...value.executionScope,
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:other:g1",
    });

    await expect(consumeScheduledPolicyLeaseForEffectClaim({
      claim: value.claim,
      executionId: value.claim.lease.executionId,
      toolId: value.claim.lease.toolId,
      inputSha256,
      targetSha256,
      influenceManifest: value.claim.influenceManifest,
      executionScope: wrongScope,
    }, value.sql as never)).rejects.toMatchObject({
      name: "PolicyLeaseStoreError",
      code: "binding_mismatch",
    });
    expect(value.statements).toEqual([]);
  });

  it("revalidates principal generation from the locked current schedule", async () => {
    const value = fixture({ scheduleGeneration: 8 });

    await expect(consumeScheduledPolicyLeaseForEffectClaim({
      claim: value.claim,
      executionId: value.claim.lease.executionId,
      toolId: value.claim.lease.toolId,
      inputSha256,
      targetSha256,
      influenceManifest: value.claim.influenceManifest,
      executionScope: value.executionScope,
    }, value.sql as never)).rejects.toBeInstanceOf(PolicyLeaseStoreError);
    expect(value.statements.some((statement) =>
      statement.includes("FOR UPDATE OF occurrence, trigger")
    )).toBe(true);
    expect(value.statements.some((statement) =>
      statement.includes("INSERT INTO omni_policy_lease_consumptions")
    )).toBe(false);
  });

  it("rejects a different actual influence manifest before effect claim", async () => {
    const value = fixture();
    const changed = fixture({ manifestContentSha256: "d".repeat(64) });

    await expect(consumeScheduledPolicyLeaseForEffectClaim({
      claim: value.claim,
      executionId: value.claim.lease.executionId,
      toolId: value.claim.lease.toolId,
      inputSha256,
      targetSha256,
      influenceManifest: changed.claim.influenceManifest,
      executionScope: value.executionScope,
    }, value.sql as never)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect(value.statements).toEqual([]);
  });

  it("pins v199 to its name digest and verifies exact column-only consumption grants", async () => {
    const migrationName = "scheduled_workflow_policy_lease_v1";
    const checksum = createHash("sha256").update(migrationName).digest("hex");
    const migration = await readFile(path.join(
      process.cwd(),
      "supabase/migrations/20260922160000_scheduled_workflow_policy_lease.sql",
    ), "utf8");
    expect(checksum).toBe(
      "56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093",
    );
    expect(migration).toContain("version, name, checksum, applied_at");
    expect(migration).toContain(
      "GRANT UPDATE (state, consumed_at, consumption_receipt_sha256)",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.omni_policy_leases FROM omni_runtime",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.omni_policy_lease_consumptions FROM omni_maintenance",
    );
    expect(migration).toContain("information_schema.role_table_grants");
    expect(migration).toContain("information_schema.role_column_grants");
    expect(migration).toContain("column_name NOT IN (");
    expect(migration).toContain("count(DISTINCT grant_row.column_name)");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("expires_at <= issued_at + INTERVAL '15 minutes'");
  });
});
