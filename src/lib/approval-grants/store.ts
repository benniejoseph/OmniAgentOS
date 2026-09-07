import { createHash, randomUUID } from "node:crypto";

import {
  buildApprovalGrantClaimV1,
  buildApprovalGrantV1,
  evaluateApprovalGrant,
  approvalGrantClaimV1Schema,
  approvalGrantV1Schema,
  type ApprovalGrantClaimV1,
  type ApprovalGrantDecision,
  type ApprovalGrantRequest,
  type ApprovalGrantV1,
} from "@/lib/approval-grants/contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const DEFAULT_GRANT_LIFETIME_MS = 60 * 60 * 1_000;

type ApprovalGrantLedger = {
  grants: ApprovalGrantV1[];
  claims: ApprovalGrantClaimV1[];
};

export type ApprovalGrantMutationScope = {
  executionScope: ExecutionScope;
};

export type IssueApprovalGrantInput = ApprovalGrantRequest & {
  approvedByActorId: string;
  sourceApprovalId: string;
  approvedAt: string;
  maxUses: number;
  lifetimeMs?: number;
};

export type ApprovalGrantClaimResult = Readonly<
  | {
      outcome: "claimed" | "existing";
      grant: ApprovalGrantV1;
      claim: ApprovalGrantClaimV1;
    }
  | {
      outcome: "denied";
      reason: Exclude<ApprovalGrantDecision, { allowed: true }>["reason"] | "not_found";
      grant?: ApprovalGrantV1;
    }
>;

export async function issueApprovalGrant(
  input: IssueApprovalGrantInput,
  options: ApprovalGrantMutationScope,
): Promise<{ grant: ApprovalGrantV1; created: boolean }> {
  const scope = requireGrantScope(options.executionScope);
  assertGrantRequestScope(input, scope);
  const approvedAt = timestamp(input.approvedAt);
  const lifetimeMs = grantLifetime(input.lifetimeMs);
  const grantId = deterministicGrantId(input);
  const grant = buildApprovalGrantV1({
    version: "p9.4-approval-grant:1",
    grantId,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    approvedByActorId: required(input.approvedByActorId, "approver actor"),
    executingPrincipalType: input.executingPrincipalType,
    executingPrincipalId: input.executingPrincipalId,
    planId: input.planId,
    planSha256: input.planSha256,
    domain: input.domain,
    actionClass: input.actionClass,
    toolId: input.toolId,
    toolContractSha256: input.toolContractSha256,
    targetSha256: input.targetSha256,
    riskLevel: input.riskLevel,
    reversible: true,
    sourceApprovalId: required(input.sourceApprovalId, "source approval"),
    issuedAt: approvedAt,
    expiresAt: new Date(Date.parse(approvedAt) + lifetimeMs).toISOString(),
    maxUses: input.maxUses,
    usedUses: 0,
    state: "active",
    lifecycleRevision: 1,
    lastUsedAt: null,
    revokedAt: null,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const inserted = await sql`
        INSERT INTO omni_approval_grants (
          tenant_id, owner_actor_id, grant_id, source_approval_id,
          binding_sha256, plan_id, plan_sha256, domain, action_class,
          tool_id, tool_contract_sha256, target_sha256,
          executing_principal_type, executing_principal_id,
          state, used_uses, max_uses, lifecycle_revision,
          grant, issued_at, expires_at
        ) VALUES (
          ${grant.tenantId}, ${grant.ownerActorId}, ${grant.grantId},
          ${grant.sourceApprovalId}, ${grant.bindingSha256}, ${grant.planId},
          ${grant.planSha256}, ${grant.domain}, ${grant.actionClass},
          ${grant.toolId}, ${grant.toolContractSha256}, ${grant.targetSha256},
          ${grant.executingPrincipalType}, ${grant.executingPrincipalId},
          ${grant.state}, ${grant.usedUses}, ${grant.maxUses},
          ${grant.lifecycleRevision}, ${grant}::jsonb, ${grant.issuedAt},
          ${grant.expiresAt}
        )
        ON CONFLICT (tenant_id, owner_actor_id, grant_id) DO NOTHING
        RETURNING grant
      `;
      if (inserted[0]) {
        await appendGrantEvent("issued", grant, scope, sql);
        return { grant, created: true };
      }
      const existing = await readGrantDb(grant.grantId, scope, sql);
      if (!existing || existing.bindingSha256 !== grant.bindingSha256) {
        throw new Error("Approval grant identity conflicts with a different binding.");
      }
      return { grant: existing, created: false };
    }) as Promise<{ grant: ApprovalGrantV1; created: boolean }>;
  }

  let result = { grant, created: true };
  await updateJsonFile<ApprovalGrantLedger>(
    approvalGrantFile(),
    emptyLedger(),
    (ledger) => {
      const existing = ledger.grants.find((candidate) =>
        candidate.tenantId === grant.tenantId &&
        candidate.ownerActorId === grant.ownerActorId &&
        candidate.grantId === grant.grantId
      );
      if (existing) {
        const parsed = approvalGrantV1Schema.parse(existing);
        if (parsed.bindingSha256 !== grant.bindingSha256) {
          throw new Error("Approval grant identity conflicts with a different binding.");
        }
        result = { grant: parsed, created: false };
        return ledger;
      }
      return { ...ledger, grants: [grant, ...ledger.grants] };
    },
  );
  if (result.created) await appendGrantEvent("issued", grant, scope);
  return result;
}

export async function claimApprovalGrant(
  input: {
    grantId: string;
    request: ApprovalGrantRequest;
    executionKey: string;
    now?: string;
  },
  options: ApprovalGrantMutationScope,
): Promise<ApprovalGrantClaimResult> {
  const scope = requireGrantScope(options.executionScope);
  assertGrantRequestScope(input.request, scope);
  const claimedAt = timestamp(input.now);
  const executionKeySha256 = canonicalJsonSha256({
    tenantId: input.request.tenantId,
    ownerActorId: input.request.ownerActorId,
    executionKey: required(input.executionKey, "execution key"),
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const grant = await readGrantDb(input.grantId, scope, sql, true);
      if (!grant) return { outcome: "denied", reason: "not_found" };
      const prior = await readClaimDb(
        grant.grantId,
        executionKeySha256,
        scope,
        sql,
      );
      if (prior) return { outcome: "existing", grant, claim: prior };
      const decision = evaluateApprovalGrant(
        grant,
        input.request,
        new Date(claimedAt),
      );
      if (!decision.allowed) {
        return { outcome: "denied", reason: decision.reason, grant };
      }
      const claim = buildGrantClaim(
        grant,
        executionKeySha256,
        claimedAt,
      );
      const updated = consumeGrant(grant, claimedAt);
      await sql`
        UPDATE omni_approval_grants
        SET state = ${updated.state}, used_uses = ${updated.usedUses},
            lifecycle_revision = ${updated.lifecycleRevision},
            grant = ${updated}::jsonb, last_used_at = ${updated.lastUsedAt}
        WHERE tenant_id = ${grant.tenantId}
          AND owner_actor_id = ${grant.ownerActorId}
          AND grant_id = ${grant.grantId}
          AND lifecycle_revision = ${grant.lifecycleRevision}
      `;
      await sql`
        INSERT INTO omni_approval_grant_claims (
          tenant_id, owner_actor_id, claim_id, grant_id,
          grant_binding_sha256, execution_key_sha256, use_ordinal,
          claim, claimed_at
        ) VALUES (
          ${claim.tenantId}, ${claim.ownerActorId}, ${claim.claimId},
          ${claim.grantId}, ${claim.grantBindingSha256},
          ${claim.executionKeySha256}, ${claim.useOrdinal},
          ${claim}::jsonb, ${claim.claimedAt}
        )
      `;
      await appendGrantEvent("consumed", updated, scope, sql, claim);
      return { outcome: "claimed", grant: updated, claim };
    }) as Promise<ApprovalGrantClaimResult>;
  }

  const holder: { result: ApprovalGrantClaimResult } = {
    result: { outcome: "denied", reason: "not_found" },
  };
  await updateJsonFile<ApprovalGrantLedger>(
    approvalGrantFile(),
    emptyLedger(),
    (ledger) => {
      const grantIndex = ledger.grants.findIndex((candidate) =>
        candidate.tenantId === scope.tenantId &&
        candidate.ownerActorId === scope.initiatingActorId &&
        candidate.grantId === input.grantId
      );
      if (grantIndex < 0) return ledger;
      const grant = approvalGrantV1Schema.parse(ledger.grants[grantIndex]);
      const prior = ledger.claims.find((candidate) =>
        candidate.grantId === grant.grantId &&
        candidate.executionKeySha256 === executionKeySha256
      );
      if (prior) {
        holder.result = {
          outcome: "existing",
          grant,
          claim: approvalGrantClaimV1Schema.parse(prior),
        };
        return ledger;
      }
      const decision = evaluateApprovalGrant(
        grant,
        input.request,
        new Date(claimedAt),
      );
      if (!decision.allowed) {
        holder.result = { outcome: "denied", reason: decision.reason, grant };
        return ledger;
      }
      const claim = buildGrantClaim(grant, executionKeySha256, claimedAt);
      const updated = consumeGrant(grant, claimedAt);
      const grants = [...ledger.grants];
      grants[grantIndex] = updated;
      holder.result = { outcome: "claimed", grant: updated, claim };
      return { grants, claims: [claim, ...ledger.claims] };
    },
  );
  if (holder.result.outcome === "claimed") {
    await appendGrantEvent(
      "consumed",
      holder.result.grant,
      scope,
      undefined,
      holder.result.claim,
    );
  }
  return holder.result;
}

export async function revokeApprovalGrantsForPlan(
  input: { planId: string; planSha256: string; now?: string },
  options: ApprovalGrantMutationScope,
) {
  const scope = requireGrantScope(options.executionScope);
  const revokedAt = timestamp(input.now);
  const revoke = (grant: ApprovalGrantV1) => buildApprovalGrantV1({
    ...grant,
    state: "revoked",
    lifecycleRevision: grant.lifecycleRevision + 1,
    revokedAt,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        SELECT grant FROM omni_approval_grants
        WHERE tenant_id = ${scope.tenantId}
          AND owner_actor_id = ${scope.initiatingActorId}
          AND plan_id = ${required(input.planId, "plan id")}
          AND plan_sha256 = ${required(input.planSha256, "plan digest")}
          AND state = 'active'
        FOR UPDATE
      `;
      const revoked: ApprovalGrantV1[] = [];
      for (const row of rows) {
        const updated = revoke(approvalGrantV1Schema.parse(row.grant));
        await sql`
          UPDATE omni_approval_grants
          SET state = ${updated.state}, lifecycle_revision = ${updated.lifecycleRevision},
              grant = ${updated}::jsonb, revoked_at = ${updated.revokedAt}
          WHERE tenant_id = ${updated.tenantId}
            AND owner_actor_id = ${updated.ownerActorId}
            AND grant_id = ${updated.grantId}
        `;
        await appendGrantEvent("revoked", updated, scope, sql);
        revoked.push(updated);
      }
      return revoked;
    }) as Promise<ApprovalGrantV1[]>;
  }

  const revoked: ApprovalGrantV1[] = [];
  await updateJsonFile<ApprovalGrantLedger>(
    approvalGrantFile(),
    emptyLedger(),
    (ledger) => ({
      ...ledger,
      grants: ledger.grants.map((candidate) => {
        const grant = approvalGrantV1Schema.parse(candidate);
        if (
          grant.tenantId !== scope.tenantId ||
          grant.ownerActorId !== scope.initiatingActorId ||
          grant.planId !== input.planId ||
          grant.planSha256 !== input.planSha256 ||
          grant.state !== "active"
        ) return grant;
        const updated = revoke(grant);
        revoked.push(updated);
        return updated;
      }),
    }),
  );
  for (const grant of revoked) {
    await appendGrantEvent("revoked", grant, scope);
  }
  return revoked;
}

export async function listApprovalGrants(
  options: ApprovalGrantMutationScope & { limit?: number },
) {
  const scope = requireGrantScope(options.executionScope);
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT grant FROM omni_approval_grants
      WHERE tenant_id = ${scope.tenantId}
        AND owner_actor_id = ${scope.initiatingActorId}
      ORDER BY issued_at DESC, grant_id ASC LIMIT ${limit}
    `;
    return rows.map((row) => approvalGrantV1Schema.parse(row.grant));
  }
  const ledger = await readGrantLedger();
  return ledger.grants
    .filter((grant) =>
      grant.tenantId === scope.tenantId &&
      grant.ownerActorId === scope.initiatingActorId
    )
    .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))
    .slice(0, limit);
}

function consumeGrant(grant: ApprovalGrantV1, claimedAt: string) {
  const usedUses = grant.usedUses + 1;
  return buildApprovalGrantV1({
    ...grant,
    usedUses,
    state: usedUses === grant.maxUses ? "exhausted" : "active",
    lifecycleRevision: grant.lifecycleRevision + 1,
    lastUsedAt: claimedAt,
  });
}

function buildGrantClaim(
  grant: ApprovalGrantV1,
  executionKeySha256: string,
  claimedAt: string,
) {
  return buildApprovalGrantClaimV1({
    version: "p9.4-approval-grant-claim:1",
    claimId: deterministicClaimId(grant.grantId, executionKeySha256),
    grantId: grant.grantId,
    grantBindingSha256: grant.bindingSha256,
    tenantId: grant.tenantId,
    ownerActorId: grant.ownerActorId,
    executionKeySha256,
    useOrdinal: grant.usedUses + 1,
    claimedAt,
  });
}

async function readGrantDb(
  grantId: string,
  scope: ExecutionScope & { initiatingActorId: string },
  sql: ReturnType<typeof getSql>,
  forUpdate = false,
) {
  const rows = await sql.query(
    `SELECT grant FROM omni_approval_grants
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND grant_id = $3
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [scope.tenantId, scope.initiatingActorId, grantId],
  );
  return rows[0] ? approvalGrantV1Schema.parse(rows[0].grant) : undefined;
}

async function readClaimDb(
  grantId: string,
  executionKeySha256: string,
  scope: ExecutionScope & { initiatingActorId: string },
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    SELECT claim FROM omni_approval_grant_claims
    WHERE tenant_id = ${scope.tenantId}
      AND owner_actor_id = ${scope.initiatingActorId}
      AND grant_id = ${grantId}
      AND execution_key_sha256 = ${executionKeySha256}
    LIMIT 1
  `;
  return rows[0]
    ? approvalGrantClaimV1Schema.parse(rows[0].claim)
    : undefined;
}

async function appendGrantEvent(
  action: "issued" | "consumed" | "revoked",
  grant: ApprovalGrantV1,
  executionScope: ExecutionScope,
  sql?: ReturnType<typeof getSql>,
  claim?: ApprovalGrantClaimV1,
) {
  await appendScopedDomainEvent({
    id: action === "consumed" && claim
      ? `approval-grant-event:v1:${claim.claimSha256}`
      : `approval-grant-event:v1:${action}:${grant.grantId}:${grant.lifecycleRevision}`,
    streamId: `approval-grant:${grant.grantId}`,
    type: `approval.grant.${action}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      grantId: grant.grantId,
      bindingSha256: grant.bindingSha256,
      planId: grant.planId,
      planSha256: grant.planSha256,
      domain: grant.domain,
      actionClass: grant.actionClass,
      toolId: grant.toolId,
      toolContractSha256: grant.toolContractSha256,
      targetSha256: grant.targetSha256,
      executingPrincipalType: grant.executingPrincipalType,
      executingPrincipalId: grant.executingPrincipalId,
      state: grant.state,
      usedUses: grant.usedUses,
      maxUses: grant.maxUses,
      lifecycleRevision: grant.lifecycleRevision,
      expiresAt: grant.expiresAt,
      ...(claim
        ? {
            claimSha256: claim.claimSha256,
            executionKeySha256: claim.executionKeySha256,
            useOrdinal: claim.useOrdinal,
          }
        : {}),
    },
  }, sql ? { sql } : {});
}

function assertGrantRequestScope(
  request: ApprovalGrantRequest,
  scope: ExecutionScope & { initiatingActorId: string; executingPrincipalId: string },
) {
  if (
    request.tenantId !== scope.tenantId ||
    request.ownerActorId !== scope.initiatingActorId ||
    request.executingPrincipalType !== scope.executingPrincipalType ||
    request.executingPrincipalId !== scope.executingPrincipalId
  ) {
    throw new Error("Approval grant request does not match its execution scope.");
  }
}

function requireGrantScope(
  value: ExecutionScope,
): ExecutionScope & { initiatingActorId: string; executingPrincipalId: string } {
  const scope = parsePersistedExecutionScope(value);
  if (!scope?.initiatingActorId || !scope.executingPrincipalId) {
    throw new Error("Approval grants require actor and principal-bound execution scope.");
  }
  assertExecutionScopeTenant(scope, scope.tenantId);
  return scope as ExecutionScope & {
    initiatingActorId: string;
    executingPrincipalId: string;
  };
}

function deterministicGrantId(input: IssueApprovalGrantInput) {
  return `grant:${digestUuid(canonicalJsonSha256({
    version: "p9.4-approval-grant-id:1",
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    sourceApprovalId: input.sourceApprovalId,
    executingPrincipalType: input.executingPrincipalType,
    executingPrincipalId: input.executingPrincipalId,
    planId: input.planId,
    planSha256: input.planSha256,
    domain: input.domain,
    actionClass: input.actionClass,
    toolId: input.toolId,
    toolContractSha256: input.toolContractSha256,
    targetSha256: input.targetSha256,
    riskLevel: input.riskLevel,
    maxUses: input.maxUses,
  }))}`;
}

function deterministicClaimId(grantId: string, executionKeySha256: string) {
  return `claim:${digestUuid(createHash("sha256")
    .update(`${grantId}\0${executionKeySha256}`)
    .digest("hex"))}`;
}

function digestUuid(digest: string) {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = (8 + (Number.parseInt(chars[16] || "0", 16) % 4)).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function timestamp(value?: string) {
  const result = value ? new Date(value) : new Date();
  if (!Number.isFinite(result.getTime())) {
    throw new Error("Invalid approval grant timestamp.");
  }
  return result.toISOString();
}

function grantLifetime(value?: number) {
  const lifetime = value ?? DEFAULT_GRANT_LIFETIME_MS;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < 60_000 ||
    lifetime > 24 * 60 * 60 * 1_000
  ) {
    throw new Error("Approval grant lifetime must be between one minute and 24 hours.");
  }
  return lifetime;
}

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Approval grant ${label} is required.`);
  return normalized;
}

async function readGrantLedger() {
  const ledger = await readJsonFile<ApprovalGrantLedger>(
    approvalGrantFile(),
    emptyLedger(),
  );
  return {
    grants: ledger.grants.map((grant) => approvalGrantV1Schema.parse(grant)),
    claims: ledger.claims.map((claim) =>
      approvalGrantClaimV1Schema.parse(claim)
    ),
  };
}

function emptyLedger(): ApprovalGrantLedger {
  return { grants: [], claims: [] };
}

function approvalGrantFile() {
  return getDataPath("approval-grants.json");
}

// Retained for callers that need an unguessable correlation key outside the
// deterministic grant and claim identities.
export function createApprovalGrantExecutionKey() {
  return randomUUID();
}
