import { z } from "zod";
import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { canonicalWorkItemV1Schema, parseCanonicalWorkItemV1, type CanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import { exactIdSchema, instantSchema, responsibilityWorkSchema } from "./contracts";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";
import { lockResponsibilityWorkspace } from "./workspace-read-fence";

export const WORK_ITEM_FOLLOWTHROUGH_PROCEDURE = "responsibility.work_item.followthrough.v1" as const;
export const workItemDependencyReadSchema = z.discriminatedUnion("state", [
  z.object({ id: exactIdSchema, state: z.literal("available"), canonicalStatus: canonicalWorkItemV1Schema.shape.canonicalStatus,
    sourceStatus: canonicalWorkItemV1Schema.shape.sourceStatus, projectionSha256: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: instantSchema }).strict(),
  z.object({ id: exactIdSchema, state: z.literal("unavailable") }).strict(),
]);
export const workItemSourceReadSchema = z.object({ workItem: canonicalWorkItemV1Schema, projectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  dependencies: z.array(workItemDependencyReadSchema).max(256), revisionSha256: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: instantSchema }).strict();
export type WorkItemSourceRead = z.infer<typeof workItemSourceReadSchema>;

/** Local authoritative read: no provider freshness claim. Membership, owner,
 * identity and projection digest are checked under locks in the caller's
 * transaction. A dependency outside this same scope contributes no content. */
export async function readOwnedWorkItemWithSql(sql: SqlClient, owner: ResponsibilityOwner,
  rawWork: z.infer<typeof responsibilityWorkSchema>, checkedAt: string): Promise<WorkItemSourceRead> {
  const work = responsibilityWorkSchema.parse(rawWork); instantSchema.parse(checkedAt);
  if (!sql.transactionScoped) throw unavailable();
  if (!await lockResponsibilityWorkspace(sql, owner, work.workspaceId)) throw unavailable();
  const rows = await sql`SELECT projection, projection_sha256 FROM omni_work_items WHERE tenant_id = ${owner.tenantId}
    AND workspace_id = ${work.workspaceId} AND project_id = ${work.projectId} AND work_item_id = ${work.workItemId}
    AND owner_actor_ids @> ${[owner.actorId]}::jsonb FOR SHARE`;
  if (rows.length !== 1) throw unavailable();
  const workItem = checkedProjection(rows[0], owner, work);
  const dependencies: WorkItemSourceRead["dependencies"] = [];
  // One bounded read, in stable lock order. Unreadable dependencies expose no
  // fields beyond the ID already present in the owner's work item.
  const related = workItem.dependencyWorkItemIds.length ? await sql`SELECT projection, projection_sha256 FROM omni_work_items WHERE tenant_id = ${owner.tenantId}
    AND workspace_id = ${work.workspaceId} AND project_id = ${work.projectId} AND work_item_id = ANY(${workItem.dependencyWorkItemIds}::text[])
    AND owner_actor_ids @> ${[owner.actorId]}::jsonb ORDER BY work_item_id FOR SHARE` : [];
  const byId = new Map<string, CanonicalWorkItemV1>();
  for (const row of related) {
    const value = parseCanonicalWorkItemV1(row.projection);
    if (!workItem.dependencyWorkItemIds.includes(value.workItemId) || byId.has(value.workItemId)) throw unavailable();
    byId.set(value.workItemId, checkedProjection(row, owner, { ...work, workItemId: value.workItemId }));
  }
  for (const id of workItem.dependencyWorkItemIds) {
    const dependency = byId.get(id);
    if (!dependency) { dependencies.push({ id, state: "unavailable" }); continue; }
    dependencies.push({ id, state: "available", canonicalStatus: dependency.canonicalStatus, sourceStatus: dependency.sourceStatus,
      projectionSha256: canonicalJsonSha256(dependency), updatedAt: dependency.updatedAt });
  }
  const projectionSha256 = canonicalJsonSha256(workItem);
  return workItemSourceReadSchema.parse({ workItem, projectionSha256, dependencies, checkedAt,
    revisionSha256: workItemSourceRevisionSha256({ projectionSha256, dependencies }) });
}
export function workItemSourceRevisionSha256(value: Pick<WorkItemSourceRead, "projectionSha256" | "dependencies">) {
  return canonicalJsonSha256({ contract: "canonical-work-item-followthrough-source:1", projectionSha256: value.projectionSha256, dependencies: value.dependencies });
}
export function verifyWorkItemSourceRead(value: unknown, owner: ResponsibilityOwner, work: z.infer<typeof responsibilityWorkSchema>) {
  const parsed = workItemSourceReadSchema.parse(value);
  checkedProjection({ projection: parsed.workItem, projection_sha256: parsed.projectionSha256 }, owner, work);
  if (canonicalJsonSha256(parsed.dependencies.map((item) => item.id)) !== canonicalJsonSha256(parsed.workItem.dependencyWorkItemIds) ||
    parsed.revisionSha256 !== workItemSourceRevisionSha256(parsed)) throw unavailable();
  return parsed;
}
function checkedProjection(row: Record<string, unknown>, owner: ResponsibilityOwner, work: z.infer<typeof responsibilityWorkSchema>): CanonicalWorkItemV1 {
  const value = parseCanonicalWorkItemV1(row.projection);
  if (value.tenantId !== owner.tenantId || value.workspaceId !== work.workspaceId || value.projectId !== work.projectId || value.workItemId !== work.workItemId ||
    !value.ownerActorIds.includes(owner.actorId) || row.projection_sha256 !== canonicalJsonSha256(value)) throw unavailable();
  return value;
}
function unavailable() { return new ResponsibilityError("This work item is unavailable or its current ownership changed.", 409, "responsibility_source_unavailable"); }
