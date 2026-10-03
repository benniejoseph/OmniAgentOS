import { arsenalAgents } from "@/lib/agents/arsenal";
import { AgentIdentityResolutionError } from "@/lib/agents/identity-contracts";
import { resolveCustomAgentIdentityWithSql } from "@/lib/agents/identity-store";
import { listCaptureAssets } from "@/lib/capture/assets";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { parseMeetingRevision } from "@/lib/meetings/contracts";
import { canonicalAuthUserActorFromSecurityContext, canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { listThreads } from "@/lib/threads/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { parseCanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import type { SavedProcedure } from "@/lib/workflows/saved-procedures";
import { exactIdSchema, type ResponsibilitySource } from "./contracts";
import { readOwnedResponsibilityProcedures } from "./procedure-reference";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";

export const RESPONSIBILITY_REFERENCES_CONTRACT = "asael-responsibility-references:1" as const;
const LIMIT = 40;
type LabelledId = { id: string; label: string };
type SourceOption = { source: ResponsibilitySource; label: string };
type WorkOption = { workspaceId: string; projectId: string; workItemId: string; label: string };
type Available<T> = { state: "available"; items: T[]; hasMore: boolean };
type Group<T> = Available<T> | { state: "unavailable"; items: []; hasMore: null; errorCode: "responsibility_reference_read_unavailable" };
type Dependencies = {
  sources(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<SourceOption>>;
  work(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<WorkOption>>;
  procedures(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<LabelledId>>;
  agents(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<LabelledId>>;
};
const defaults: Dependencies = { sources: readSources, work: readWork, procedures: readProcedures, agents: readAgents };

/** A bounded selector, never a readiness or activation receipt. Each group can
 * fail independently. Existing exact reference review revalidates all selected
 * identities and pins; no provider, workspace or principal is provisioned here. */
export async function readResponsibilityReferenceOptions(context: SecurityContext, dependencies = defaults) {
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  if (!canPerform(context.role, "read") || !canonical) throw new ResponsibilityError("An authenticated exact owner is required.", 403, "responsibility_owner_required");
  const owner = { tenantId: context.tenantId, actorId: canonical.actorId };
  const [sources, work, procedures, agents] = await Promise.all([
    readGroup(() => dependencies.sources(context, owner)), readGroup(() => dependencies.work(context, owner)),
    readGroup(() => dependencies.procedures(context, owner)), readGroup(() => dependencies.agents(context, owner)),
  ]);
  return { schemaVersion: 1 as const, contract: RESPONSIBILITY_REFERENCES_CONTRACT, owner, groups: { sources, work, procedures, agents },
    coverage: { perGroupLimit: LIMIT, totals: "unavailable" as const }, authorityEffect: "none" as const };
}
async function readGroup<T>(read: () => Promise<Available<T>>): Promise<Group<T>> {
  try { const group = await read(); if (group.items.length > LIMIT) throw invalid(); return group; }
  catch { return { state: "unavailable", items: [], hasMore: null, errorCode: "responsibility_reference_read_unavailable" }; }
}
async function scope<T>(context: SecurityContext, owner: ResponsibilityOwner, work: () => Promise<T>): Promise<T> {
  if (!hasDatabaseUrl()) throw invalid();
  await ensureDatabaseSchema();
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding || binding.canonicalActorId !== owner.actorId) throw invalid();
  return runWithDatabaseActorScope(owner.tenantId, binding.readableOwnerActorIds, work);
}
async function readSources(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<SourceOption>> {
  return scope(context, owner, async () => {
    const requestOwner = { tenantId: owner.tenantId, actorId: context.actorId, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context) };
    // The source selector reserves a bounded share for each supported kind.
    // Meeting options are native owner-private records in active memberships.
    const [threads, assets, meetings] = await Promise.all([
      listThreads(14, requestOwner), listCaptureAssets(requestOwner, 14),
      getSql()`SELECT meeting.meeting_snapshot FROM omni_meetings meeting
        JOIN omni_tenant_workspaces workspace ON workspace.tenant_id = meeting.tenant_id AND workspace.workspace_id = meeting.workspace_id AND workspace.state = 'active'
        JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id = meeting.tenant_id AND membership.workspace_id = meeting.workspace_id
          AND membership.subject_kind = 'user' AND membership.subject_actor_id = ${owner.actorId} AND membership.state = 'active'
        WHERE meeting.tenant_id = ${owner.tenantId} AND meeting.owner_actor_id = ${owner.actorId}
          AND meeting.meeting_snapshot->>'declaredAccessClass' = 'owner_private'
        ORDER BY meeting.updated_at DESC,meeting.meeting_id LIMIT 15`,
    ]);
    const items: SourceOption[] = meetings.slice(0, 14).map((row) => {
      const meeting = parseMeetingRevision(row.meeting_snapshot);
      if (!meeting || meeting.tenantId !== owner.tenantId || meeting.ownerActorId !== owner.actorId || meeting.declaredAccessClass !== "owner_private") throw invalid();
      return { source: { kind: "meeting", id: meeting.meetingId, workspaceId: meeting.workspaceId }, label: label(meeting.title, meeting.meetingId) };
    });
    for (const thread of threads.slice(0, 13)) {
      if (thread.tenantId !== owner.tenantId || thread.actorId !== context.actorId) throw invalid();
      items.push({ source: { kind: "thread", id: exactIdSchema.parse(thread.id) }, label: label(thread.title, thread.id) });
    }
    for (const asset of assets.slice(0, 13)) {
      if (asset.tenantId !== owner.tenantId || asset.actorId !== context.actorId) throw invalid();
      items.push({ source: { kind: "capture_asset", id: exactIdSchema.parse(asset.id) }, label: label(asset.filename, asset.id) });
    }
    return { state: "available", items, hasMore: threads.length > 13 || assets.length > 13 || meetings.length > 14 };
  });
}
async function readWork(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<WorkOption>> {
  return scope(context, owner, async () => {
    const rows = await getSql()`SELECT projection,projection_sha256 FROM omni_work_items WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_ids @> ${[owner.actorId]}::jsonb ORDER BY updated_at DESC,work_item_id LIMIT 41`;
    const items = rows.slice(0, LIMIT).map((row) => {
      const work = parseCanonicalWorkItemV1(row.projection);
      if (work.tenantId !== owner.tenantId || !work.ownerActorIds.includes(owner.actorId) || canonicalJsonSha256(work) !== row.projection_sha256) throw invalid();
      return { workspaceId: work.workspaceId, projectId: work.projectId, workItemId: work.workItemId, label: label(work.title, work.workItemId) };
    });
    return { state: "available", items, hasMore: rows.length > LIMIT };
  });
}
async function readProcedures(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<LabelledId>> {
  return scope(context, owner, async () => {
    const rows = await getSql().transaction((sql: SqlClient) => readOwnedResponsibilityProcedures(sql, owner, { lock: false, now: new Date().toISOString() })) as readonly SavedProcedure[];
    const counts = new Map<string, number>(); for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    const unique = rows.filter((row) => counts.get(row.id) === 1);
    return { state: "available", items: unique.slice(0, LIMIT).map((row) => ({ id: row.id, label: label(row.aliases[0], row.id) })), hasMore: unique.length > LIMIT };
  });
}
async function readAgents(context: SecurityContext, owner: ResponsibilityOwner): Promise<Available<LabelledId>> {
  return scope(context, owner, async () => {
    const items = arsenalAgents.map((agent) => ({ id: agent.id, label: label(agent.name, agent.id) }));
    const rows = await getSql()`SELECT agent_definition_id FROM omni_agent_release_channels WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId} AND state = 'active' ORDER BY agent_definition_id LIMIT 41`;
    const seen = new Set(items.map((item) => item.id));
    for (const row of rows.slice(0, LIMIT)) {
      const id = exactIdSchema.parse(row.agent_definition_id); if (seen.has(id)) throw invalid(); seen.add(id);
      try {
        const identity = await resolveCustomAgentIdentityWithSql({ ...owner, ownerActorId: owner.actorId, agentId: id, sql: getSql() });
        if (identity.principal.tenantId !== owner.tenantId || identity.principal.controllerActorId !== owner.actorId || identity.principal.state !== "active" ||
          (identity.principal.expiresAt !== null && identity.principal.expiresAt <= new Date().toISOString())) continue;
        items.push({ id, label: label(identity.definition.name, id) });
      } catch (error) { if (!(error instanceof AgentIdentityResolutionError)) throw error; }
    }
    return { state: "available", items: items.slice(0, LIMIT), hasMore: rows.length > LIMIT || items.length > LIMIT };
  });
}
function label(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : fallback; }
function invalid() { return new Error("The bounded owner reference read is unavailable."); }
