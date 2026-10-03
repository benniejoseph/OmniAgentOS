import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ToolDefinition } from "@/lib/tools/types";
import { verifyLifecycle, verifyWake } from "./lifecycle-state";
import { RESPONSIBILITY_DUE_GRACE_MS, type ResponsibilityLifecycle, type ResponsibilityWake } from "./runtime-contracts";
import { ResponsibilityError } from "./state";

export const RESPONSIBILITY_EXECUTION_PURPOSE = "responsibility.runtime.v1";
declare const admissionBrand: unique symbol;
export type ResponsibilityDispatchAdmission = Readonly<{ readonly [admissionBrand]: true }>;
type Admission = { active: boolean; sql: SqlClient; current: ResponsibilityLifecycle; wake: ResponsibilityWake; tokenSha256: string; authorityExpiresAt: string | null; now: () => string };
const admissions = new WeakMap<object, Admission>();

/** Transaction-local capability. It cannot be reconstructed from a workflow
 * metadata field, an approval or JSON. The owner transaction remains open and
 * holds its generation/source locks until this callback and evidence commit. */
export async function withResponsibilityDispatchAdmission<T>(input: {
  sql: SqlClient; current: ResponsibilityLifecycle; wake: ResponsibilityWake; leaseToken: string; authorityExpiresAt?: string | null; now?: () => string;
}, work: (admission: ResponsibilityDispatchAdmission) => Promise<T>): Promise<T> {
  if (!input.sql.transactionScoped) throw denied();
  const current = verifyLifecycle(input.current); const wake = verifyWake(input.wake);
  const authority: Admission = { active: true, sql: input.sql, current, wake, tokenSha256: canonicalJsonSha256(input.leaseToken), authorityExpiresAt: input.authorityExpiresAt ?? null, now: input.now ?? (() => new Date().toISOString()) };
  const admission = Object.freeze({}) as ResponsibilityDispatchAdmission;
  admissions.set(admission, authority);
  try { await assertLive(authority); return await work(admission); }
  finally { authority.active = false; admissions.delete(admission); }
}

export async function assertResponsibilityToolDispatch(input: {
  admission?: ResponsibilityDispatchAdmission; tool: ToolDefinition; input: Record<string, unknown>; context?: SecurityContext; executionScope?: ExecutionScope;
  requireReadOnly: boolean; dryRun: boolean; approved: boolean; forceApproval: boolean;
  existingRecord?: unknown; approvalGrantClaim?: unknown; policyLeaseClaim?: unknown;
}) {
  if (!input.admission && input.executionScope?.purpose !== RESPONSIBILITY_EXECUTION_PURPOSE) return;
  const authority = input.admission && admissions.get(input.admission);
  if (!authority || !authority.active || !input.context || !input.executionScope || !input.requireReadOnly || input.dryRun || input.approved || input.forceApproval ||
    input.existingRecord || input.approvalGrantClaim || input.policyLeaseClaim) throw denied();
  const { current, wake } = authority; const config = current.configuration; const scope = input.executionScope;
  if (input.tool.id !== config.tool.id || input.tool.status !== "active" || input.tool.riskLevel !== 0 || input.tool.approvalRequired || input.tool.operationClass !== "read_only" ||
    canonicalJsonSha256(input.tool) !== config.tool.contractSha256 || canonicalJsonSha256(input.input) !== canonicalJsonSha256(config.tool.input) ||
    input.context.tenantId !== current.tenantId || canonicalAuthUserActorFromSecurityContext(input.context)?.actorId !== current.actorId ||
    scope.tenantId !== current.tenantId || scope.initiatingActorId !== input.context.actorId || scope.executingPrincipalType !== "agent" || scope.executingPrincipalId !== config.pins.agent.id ||
    scope.purpose !== RESPONSIBILITY_EXECUTION_PURPOSE || scope.correlationId !== wake.id || scope.causationId !== wake.id ||
    scope.workspaceId !== config.pins.work.workspaceId || scope.projectId !== config.pins.work.projectId || scope.missionId !== null || scope.delegationId !== null || scope.contextGrantIds.length || scope.capabilityGrantIds.length) throw denied();
  await assertLive(authority);
}
async function assertLive(authority: Admission) {
  if (!authority.active) throw denied();
  const { current, wake, sql } = authority;
  const rows = await sql`SELECT lifecycle.snapshot AS lifecycle_snapshot, wake.snapshot AS wake_snapshot
    FROM omni_responsibility_lifecycles lifecycle JOIN omni_responsibility_wakes wake
      ON wake.tenant_id = lifecycle.tenant_id AND wake.actor_id = lifecycle.actor_id AND wake.responsibility_id = lifecycle.responsibility_id
    JOIN omni_workflow_runs workflow ON workflow.tenant_id = wake.tenant_id AND workflow.id = wake.workflow_run_id AND workflow.status = 'queued'
    WHERE lifecycle.tenant_id = ${current.tenantId} AND lifecycle.actor_id = ${current.actorId}
      AND lifecycle.responsibility_id = ${current.responsibilityId} AND wake.id = ${wake.id}
    FOR UPDATE OF lifecycle, wake, workflow`;
  if (!authority.active || rows.length !== 1) throw denied();
  const live = verifyLifecycle(rows[0].lifecycle_snapshot); const claim = verifyWake(rows[0].wake_snapshot); const now = authority.now();
  if (live.state !== "active" || live.generation !== current.generation || live.configuration.configurationSha256 !== current.configuration.configurationSha256 ||
    live.configuration.cadence.expiresAt <= now || claim.state !== "running" || claim.generation !== live.generation || claim.leaseGeneration !== wake.leaseGeneration ||
    claim.workflowRunId !== wake.workflowRunId || claim.leaseTokenSha256 !== authority.tokenSha256 || !claim.leaseExpiresAt || claim.leaseExpiresAt <= now ||
    (authority.authorityExpiresAt !== null && authority.authorityExpiresAt <= now) || Date.parse(now) - Date.parse(claim.scheduledFor) > RESPONSIBILITY_DUE_GRACE_MS) throw denied();
}
function denied() { return new ResponsibilityError("This exact responsibility generation no longer admits governed dispatch.", 409, "responsibility_generation_fenced"); }
