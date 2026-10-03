import { AgentIdentityResolutionError, buildAgentRunIdentityPinV1, buildBuiltInAgentIdentityV1, isBuiltInAgentIdentityId, type ResolvedAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { resolveCustomAgentIdentityWithSql } from "@/lib/agents/identity-store";
import type { SqlClient } from "@/lib/db/sql-types";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";
import { buildWorkflowProcedureSnapshot } from "@/lib/workflows/saved-procedures";
import { nextWorkflowScheduleOccurrence } from "@/lib/workflows/triggers";
import type { WorkflowScheduleConfigV1 } from "@/lib/workflows/types";
import { parseCanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import type { ResponsibilityRecord } from "./contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "./comparison-policy";
import { PILOT_CHECK_RESERVATION } from "./cumulative-budget";
import { verifyPilotConfiguration } from "./lifecycle-state";
import { authoritativeSourceReadSchema } from "./observation-contracts";
import { responsibilityObservationReader } from "./observation-references";
import { RESPONSIBILITY_PILOT, type PilotConfiguration } from "./runtime-contracts";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";
import { readOwnedResponsibilityProcedures } from "./procedure-reference";

/** Internal worker identity is resolved from current account records, never
 * replayed requester JSON. Locks keep membership/revocation stable through the
 * short local read. This grants no more than the existing manage.workflow role. */
export async function resolveRuntimeOwnerContext(sql: SqlClient, owner: ResponsibilityOwner): Promise<SecurityContext> {
  requireTransaction(sql);
  const match = /^actor:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(owner.actorId);
  if (!match) throw denied();
  const rows = await sql`SELECT account.id, account.email, membership.role, tenant.name
    FROM omni_auth_users account JOIN omni_auth_memberships membership ON membership.user_id = account.id
    JOIN omni_auth_tenants tenant ON tenant.id = membership.tenant_id
    WHERE account.id = ${match[1]} AND membership.tenant_id = ${owner.tenantId}
      AND account.status = 'active' AND membership.status = 'active' FOR SHARE OF account, membership`;
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.email !== "string" || !row.email || !["operator", "admin", "system"].includes(String(row.role))) throw denied();
  const context: SecurityContext = { tenantId: owner.tenantId, actorId: row.email, role: row.role as SecurityContext["role"], source: "session",
    auth: { userId: match[1], email: row.email, sessionId: "responsibility-runtime-current-account", tenantName: String(row.name) } };
  if (!canPerform(context.role, "manage.workflow")) throw denied();
  return context;
}

/** No provisioning: the selected procedure, work and Agent must already exist.
 * Source revisions may advance after activation; the authored owner, consent,
 * source identity, procedure and Agent authority cannot silently change. */
export async function resolveResponsibilityPilot(sql: SqlClient, owner: ResponsibilityOwner, record: ResponsibilityRecord, now: string, activating: boolean) {
  requireTransaction(sql);
  const context = await resolveRuntimeOwnerContext(sql, owner);
  const { draft, review } = record;
  if (record.tenantId !== owner.tenantId || record.actorId !== owner.actorId || record.state !== "reviewed" || !review || !draft.cadence || !draft.limits || !draft.work || !draft.agentId || !draft.procedureId ||
    draft.sources.length !== 1 || draft.sources[0].kind !== "meeting" || draft.cadence.frequency === "hourly") throw unsupported();
  const source = draft.sources[0];
  const accessRows = await sql`SELECT workspace.workspace_id FROM omni_tenant_workspaces workspace
    JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id = workspace.tenant_id AND membership.workspace_id = workspace.workspace_id
      AND membership.subject_kind = 'user' AND membership.subject_actor_id = ${owner.actorId} AND membership.state = 'active'
    WHERE workspace.tenant_id = ${owner.tenantId} AND workspace.workspace_id = ${source.workspaceId} AND workspace.state = 'active'
    FOR SHARE OF workspace, membership`;
  if (accessRows.length !== 1) throw denied();
  const target = { ...owner, responsibilityId: record.id, responsibilityRevision: record.revision, reviewSha256: review.reviewSha256 };
  const sourceReader = responsibilityObservationReader(context, owner);
  const evidence = authoritativeSourceReadSchema.parse(await sourceReader({ target, source, observedAt: now }, sql));
  if (evidence.state !== "available" || evidence.freshUntil <= now || evidence.observedAt > now || !evidence.projection.meeting) throw unavailable();
  if (evidence.projection.meeting.status === "cancelled") throw stop("meeting_canceled");
  if (evidence.projection.meeting.status !== "scheduled" || !evidence.projection.meeting.startsAt || evidence.projection.meeting.startsAt <= now) throw stop("meeting_started");
  if (activating && evidence.revisionSha256 !== review.pins.sources[0]?.revisionSha256) throw changed();

  const workRows = await sql`SELECT projection, projection_sha256 FROM omni_work_items WHERE tenant_id = ${owner.tenantId}
    AND workspace_id = ${draft.work.workspaceId} AND project_id = ${draft.work.projectId} AND work_item_id = ${draft.work.workItemId}
    AND owner_actor_ids @> ${[owner.actorId]}::jsonb FOR SHARE`;
  if (workRows.length !== 1) throw changed();
  const work = parseCanonicalWorkItemV1(workRows[0].projection);
  if (canonicalJsonSha256(work) !== review.pins.work.projectionSha256 || workRows[0].projection_sha256 !== review.pins.work.projectionSha256 ||
    work.tenantId !== owner.tenantId || !work.ownerActorIds.includes(owner.actorId)) throw changed();
  // Only bound, exact-owner saved procedures are eligible for standing runtime.
  // Legacy tenant-wide procedures can still be drafted/reviewed, but cannot
  // manufacture standing authority in this pilot. The bounded ambiguity check
  // fails closed, rather than choosing a duplicate contract ID.
  const procedures = (await readOwnedResponsibilityProcedures(sql, owner, { lock: true, now })).filter((item) => item.id === draft.procedureId);
  if (procedures.length !== 1) throw changed();
  const procedure = buildWorkflowProcedureSnapshot(procedures[0], procedures[0].aliases[0]);
  const tool = getGovernedTool("app.meetings.show");
  const exactInput = { workspaceId: source.workspaceId, meetingId: source.id };
  if (procedure.snapshotSha256 !== review.pins.procedure.snapshotSha256 || procedure.toolBindings.length !== 1 || procedure.toolBindings[0].toolId !== "app.meetings.show" ||
    canonicalJsonSha256(procedure.toolBindings[0].input) !== canonicalJsonSha256(exactInput) || !tool || tool.status !== "active" || tool.riskLevel !== 0 || tool.approvalRequired) throw unsupported();
  const toolsSha = canonicalJsonSha256([{ id: tool.id, inputSha256: canonicalJsonSha256(exactInput), contractSha256: canonicalJsonSha256(tool) }]);
  if (toolsSha !== review.pins.procedure.toolBindingsSha256) throw changed();
  if (!isBuiltInAgentIdentityId(draft.agentId)) {
    const principals = await sql`SELECT principal_id FROM omni_tenant_execution_principals WHERE tenant_id = ${owner.tenantId}
      AND controller_actor_id = ${owner.actorId} AND agent_definition_id = ${draft.agentId} AND state = 'active' FOR SHARE`;
    const releases = await sql`SELECT agent_definition_id FROM omni_agent_release_channels WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId} AND agent_definition_id = ${draft.agentId} FOR SHARE`;
    if (principals.length !== 1 || releases.length !== 1) throw changed();
  }
  let identity: ResolvedAgentIdentityV1;
  try {
    identity = isBuiltInAgentIdentityId(draft.agentId)
      ? buildBuiltInAgentIdentityV1({ tenantId: owner.tenantId, controllerActorId: owner.actorId, agentId: draft.agentId })
      : await resolveCustomAgentIdentityWithSql({ tenantId: owner.tenantId, ownerActorId: owner.actorId, agentId: draft.agentId, sql });
  } catch (error) { if (error instanceof AgentIdentityResolutionError) throw changed(); throw error; }
  assertCurrentRuntimePrincipal(identity.principal, owner, now);
  const agentPin = buildAgentRunIdentityPinV1({ runId: record.id, identity });
  if (agentPin.pinSha256 !== review.pins.agent.identityPinSha256 || canonicalJsonSha256(agentPin.policyPins) !== review.pins.agent.policySha256 ||
    (identity.principal.authorityMode === "explicit_grants" && !identity.principal.toolGrantIds.includes(tool.id))) throw changed();
  const body = { schemaVersion: 1 as const, pilot: RESPONSIBILITY_PILOT, responsibilityRevision: record.revision, reviewSha256: review.reviewSha256, draftSha256: record.draftSha256,
    pins: review.pins, source, tool: { id: "app.meetings.show" as const, input: exactInput, contractSha256: canonicalJsonSha256(tool) }, cadence: draft.cadence,
    maximumChecks: draft.limits.maxChecks, cumulativeLimits: draft.limits.cumulative, checkReservation: PILOT_CHECK_RESERVATION,
    comparisonPolicySha256: RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256, stops: ["expiry", "meeting_started", "meeting_canceled"],
    notificationAuthority: "none" as const, approvalAuthority: "none" as const, mutationAuthority: "none" as const };
  const configuration = verifyPilotConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) });
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: draft.cadence.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(draft.cadence.startsAt));
  const hour = Number(clock.find((part) => part.type === "hour")?.value); const minute = Number(clock.find((part) => part.type === "minute")?.value);
  const scheduleBody = { schemaVersion: 1 as const, timezone: draft.cadence.timezone,
    rrule: `FREQ=${draft.cadence.frequency.toUpperCase()};INTERVAL=${draft.cadence.interval};BYHOUR=${hour};BYMINUTE=${minute}`,
    startsAt: draft.cadence.startsAt, endsAt: draft.cadence.expiresAt, maxOccurrences: draft.limits.maxChecks, missedPolicy: "skip" as const,
    procedurePin: { schemaVersion: 1 as const, procedureId: procedure.id, snapshotSha256: procedure.snapshotSha256, reviewedSnapshotSha256: review.reviewSha256, reviewedAt: review.reviewedAt },
    agentIdentityPin: agentPin, policyPinSha256: canonicalJsonSha256(agentPin.policyPins), occurrenceBudget: PILOT_CHECK_RESERVATION, failureLimit: 1, authorityMode: "read_only" as const };
  const schedule: WorkflowScheduleConfigV1 = { ...scheduleBody, configSha256: canonicalJsonSha256(scheduleBody) };
  return { context, configuration, schedule, procedure, agentPin, evidence, sourceReader, authorityExpiresAt: identity.principal.expiresAt };
}
export function assertCurrentRuntimePrincipal(principal: Pick<ResolvedAgentIdentityV1["principal"], "tenantId" | "controllerActorId" | "state" | "expiresAt">, owner: ResponsibilityOwner, now: string) {
  if (principal.tenantId !== owner.tenantId || principal.controllerActorId !== owner.actorId || principal.state !== "active" || (principal.expiresAt !== null && principal.expiresAt <= now)) throw changed();
}
export function nextPilotDue(schedule: WorkflowScheduleConfigV1, after: string, usedChecks = 0): string | null {
  return nextWorkflowScheduleOccurrence({ config: schedule, after, completedOccurrences: usedChecks }) ?? null;
}
export function assertSamePilot(actual: PilotConfiguration, expected: PilotConfiguration) {
  if (actual.configurationSha256 !== expected.configurationSha256) throw changed();
}
function requireTransaction(sql: SqlClient) { if (!sql.transactionScoped) throw new ResponsibilityError("Responsibility authority requires a managed transaction.", 503, "responsibility_transaction_required"); }
function denied() { return new ResponsibilityError("The responsibility owner no longer holds current workflow authority.", 403, "responsibility_owner_revoked"); }
function unsupported() { return new ResponsibilityError("This pilot requires one native owner-private Meeting and one exact app.meetings.show procedure with daily or weekly cadence.", 409, "responsibility_pilot_unsupported"); }
function unavailable() { return new ResponsibilityError("Current complete authorized Meeting evidence is unavailable.", 409, "responsibility_source_unavailable"); }
function changed() { return new ResponsibilityError("Reviewed procedure, Agent or canonical work authority changed.", 409, "responsibility_authority_changed"); }
function stop(reason: string) { return new ResponsibilityError("The pilot's closed meeting stop condition has been reached.", 409, `responsibility_${reason}`); }
