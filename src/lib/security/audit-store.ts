import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import type {
  SecurityAuditLedger,
  SecurityAuditRecord,
  SecurityContext,
  SecurityDecision,
  SecurityStats,
} from "@/lib/security/types";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export async function recordSecurityAudit({
  context,
  action,
  resourceType,
  resourceId,
  decision,
  reason,
  riskLevel,
  metadata = {},
}: {
  context: SecurityContext;
  action: string;
  resourceType: string;
  resourceId?: string;
  decision: SecurityDecision;
  reason?: string;
  riskLevel?: number;
  metadata?: Record<string, unknown>;
}) {
  const record: SecurityAuditRecord = {
    id: randomUUID(),
    tenantId: context.tenantId,
    actorId: context.actorId,
    actorRole: context.role,
    action,
    resourceType,
    resourceId,
    decision,
    reason: reason ? String(redactSensitive(reason)).slice(0, 2_000) : undefined,
    riskLevel,
    metadata: boundedAuditMetadata(metadata),
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_security_audits (
        id, tenant_id, actor_id, actor_role, action, resource_type,
        resource_id, decision, reason, risk_level, metadata, created_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.actorId}, ${record.actorRole},
        ${record.action}, ${record.resourceType}, ${record.resourceId || null},
        ${record.decision}, ${record.reason || null}, ${record.riskLevel ?? null},
        ${JSON.stringify(record.metadata || {})}::jsonb, ${record.createdAt}
      )
    `;
    return record;
  }

  await mutateSecurityLedger((ledger) => {
    ledger.records.unshift(record);
    return trimSecurityLedger(ledger);
  });
  return record;
}

function boundedAuditMetadata(metadata: Record<string, unknown>) {
  const redacted = (redactSensitive(metadata) || {}) as Record<string, unknown>;
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= 64_000) {
      return redacted;
    }
    return {
      truncated: true,
      originalCharacters: serialized.length,
      keys: Object.keys(redacted).slice(0, 50),
    };
  } catch {
    return { invalidMetadata: true };
  }
}

export async function listSecurityAudits({
  tenantId,
  limit = 50,
}: {
  tenantId?: string;
  limit?: number;
} = {}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_security_audits
          WHERE tenant_id = ${tenantId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await getSql()`
          SELECT *
          FROM omni_security_audits
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
    return rows.map(securityAuditFromRow);
  }

  const ledger = await readSecurityLedger();
  return ledger.records
    .filter((record) => !tenantId || record.tenantId === tenantId)
    .slice(0, limit);
}

export async function getSecurityStats(tenantId?: string): Promise<SecurityStats> {
  const records = await listSecurityAudits({ tenantId, limit: 200 });
  return {
    total: records.length,
    byDecision: records.reduce<Record<string, number>>((acc, record) => {
      acc[record.decision] = (acc[record.decision] || 0) + 1;
      return acc;
    }, {}),
    byRole: records.reduce<Record<string, number>>((acc, record) => {
      acc[record.actorRole] = (acc[record.actorRole] || 0) + 1;
      return acc;
    }, {}),
    latest: records.slice(0, 5),
  };
}

async function readSecurityLedger() {
  return readJsonFile<SecurityAuditLedger>(getSecurityFile(), { records: [] });
}

async function mutateSecurityLedger(mutator: (ledger: SecurityAuditLedger) => SecurityAuditLedger) {
  await updateJsonFile<SecurityAuditLedger>(
    getSecurityFile(),
    { records: [] },
    (ledger) => trimSecurityLedger(mutator(ledger)),
  );
}

function trimSecurityLedger(ledger: SecurityAuditLedger): SecurityAuditLedger {
  return {
    records: ledger.records.slice(0, 1000),
  };
}

function securityAuditFromRow(row: Record<string, unknown>): SecurityAuditRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    actorRole: String(row.actor_role) as SecurityAuditRecord["actorRole"],
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
    decision: String(row.decision) as SecurityAuditRecord["decision"],
    reason: row.reason ? String(row.reason) : undefined,
    riskLevel: row.risk_level === null || row.risk_level === undefined ? undefined : Number(row.risk_level),
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function getSecurityFile() {
  return getDataPath("security-audits.json");
}
