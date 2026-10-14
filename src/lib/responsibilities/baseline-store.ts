import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { responsibilityBaselineSchema, type ResponsibilityBaseline } from "./observation-contracts";
import { storageInvalid, type ResponsibilityOwner } from "./state";

export async function readBaseline(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_baselines WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} FOR UPDATE`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? baselineFromRow(rows[0], owner, id) : null;
}
export function baselineFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const baseline = verifiedBaseline(row.snapshot);
  if (row.schema_version !== 1 || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || baseline.target.tenantId !== owner.tenantId || baseline.target.actorId !== owner.actorId || baseline.target.responsibilityId !== id ||
    Number(row.revision) !== baseline.revision || Number(row.responsibility_revision) !== baseline.target.responsibilityRevision || row.review_sha256 !== baseline.target.reviewSha256 ||
    row.policy_sha256 !== baseline.policySha256 || row.observation_id !== baseline.observationId || row.baseline_sha256 !== baseline.baselineSha256 || instant(row.accepted_at) !== baseline.acceptedAt) throw storageInvalid();
  return baseline;
}
export function verifiedBaseline(value: unknown) {
  const checked = responsibilityBaselineSchema.safeParse(value); if (!checked.success) throw storageInvalid();
  const { baselineSha256, ...body } = checked.data;
  if (canonicalJsonSha256(body) !== baselineSha256) throw storageInvalid(); verifySemantic(body.semantic);
  return checked.data;
}
function verifySemantic(value: ResponsibilityBaseline["semantic"]) { const { semanticSha256, ...body } = value; if (canonicalJsonSha256(body) !== semanticSha256) throw storageInvalid(); }
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
