import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { redactSensitive } from "@/lib/security/context";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  openJsonPayload,
  sealJsonPayload,
} from "@/lib/security/sealed-payload";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import {
  buildEffectReceiptEventPayloadV1,
  canonicalJsonSha256,
  memoryEffectTargetIdV1,
  parseEffectReceiptV1,
  type EffectReceiptV1,
} from "@/lib/tools/effect-receipt";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import { getGovernedTool } from "@/lib/tools/registry";
import { RISK3_QUORUM, type ToolExecutionLedger, type ToolExecutionRecord } from "@/lib/tools/types";

type SqlClient = ReturnType<typeof getSql>;

const DEFAULT_STALE_TOOL_EXECUTION_CLAIM_MS = 5 * 60_000;

export type ToolApprovalClaimResult = {
  outcome: "not_found" | "conflict" | "pending" | "claimed";
  record?: ToolExecutionRecord;
};

export type IdempotentToolExecutionClaimResult = {
  outcome: "claimed" | "existing";
  record: ToolExecutionRecord;
};

export function createToolExecutionRecord(
  input: Omit<ToolExecutionRecord, "id" | "createdAt">,
): ToolExecutionRecord {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  };
}

export async function saveToolExecution(record: ToolExecutionRecord) {
  if (record.effectReceipt !== undefined) {
    throw new Error(
      "Effect receipts may only be attached while finalizing a claimed execution.",
    );
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await writeToolExecutionDb(getSql(), record);
    return record;
  }

  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => {
    const existing = ledger.records.find((item) => item.id === record.id);
    const nextRecord = preserveImmutableEffectReceipt(existing, record);
    return {
      records: trimToolExecutionRecords([
        nextRecord,
        ...ledger.records.filter((item) => item.id !== record.id),
      ]),
    };
  });
  return record;
}

export async function claimIdempotentToolExecution(
  record: ToolExecutionRecord,
): Promise<IdempotentToolExecutionClaimResult> {
  if (record.effectReceipt !== undefined) {
    throw new Error("An execution claim cannot begin with an effect receipt.");
  }
  const tenantId = normalizeTenantId(record.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const inserted = await sql`
        INSERT INTO omni_tool_executions (
          id, tool_id, tool_name, risk_level, status, dry_run,
          approval_required, tenant_id, actor_id, input, output, reason,
          approval_decision, approvals, approved_by, approved_at,
          approval_reason, effect_receipt, created_at, completed_at
        )
        VALUES (
          ${record.id}, ${record.toolId}, ${record.toolName},
          ${record.riskLevel}, ${record.status}, ${record.dryRun},
          ${record.approvalRequired}, ${record.tenantId || null},
          ${record.actorId || null}, ${record.input}::jsonb,
          ${record.output ?? null}::jsonb,
          ${record.reason || null}, ${record.approvalDecision || null},
          ${record.approvals || null}::jsonb,
          ${record.approvedBy || null}, ${record.approvedAt || null},
          ${record.approvalReason || null}, ${record.effectReceipt || null}::jsonb,
          ${record.createdAt},
          ${record.completedAt || null}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) {
        return {
          outcome: "claimed" as const,
          record: recordFromRow(inserted[0]),
        };
      }
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE id = ${record.id}
          AND COALESCE(tenant_id, 'default') = ${tenantId}
        LIMIT 1
        FOR UPDATE
      `;
      if (!rows[0]) {
        throw new Error(
          "Idempotent tool execution key collided with another tenant.",
        );
      }
      const existing = recordFromRow(rows[0]);
      const reclaimed = reclaimStaleEffectExecutionRecord(existing, record);
      if (reclaimed) {
        await writeToolExecutionDb(sql, reclaimed);
        return {
          outcome: "claimed" as const,
          record: reclaimed,
        };
      }
      return {
        outcome: "existing" as const,
        record: existing,
      };
    }) as Promise<IdempotentToolExecutionClaimResult>;
  }

  let result: IdempotentToolExecutionClaimResult | undefined;
  await updateJsonFile<ToolExecutionLedger>(
    getToolLedgerFile(),
    { records: [] },
    (ledger) => {
      const existing = ledger.records.find((item) => item.id === record.id);
      if (existing) {
        if (normalizeTenantId(existing.tenantId) !== tenantId) {
          throw new Error(
            "Idempotent tool execution key collided with another tenant.",
          );
        }
        const reclaimed = reclaimStaleEffectExecutionRecord(existing, record);
        if (reclaimed) {
          result = { outcome: "claimed", record: reclaimed };
          return replaceLedgerRecord(ledger, reclaimed);
        }
        result = { outcome: "existing", record: existing };
        return ledger;
      }
      result = { outcome: "claimed", record };
      return replaceLedgerRecord(ledger, record);
    },
  );
  return result!;
}

export async function approveAndClaimToolExecution(input: {
  id: string;
  tenantId?: string;
  approvedBy: string;
  approvedRole: string;
  approvalReason?: string;
  claimToken: string;
}): Promise<ToolApprovalClaimResult> {
  const tenantId = normalizeTenantId(input.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE id = ${input.id}
          AND COALESCE(tenant_id, 'default') = ${tenantId}
        FOR UPDATE
      `;
      if (!rows[0]) {
        return { outcome: "not_found" as const };
      }
      const result = applyApprovalClaim(recordFromRow(rows[0]), input);
      if (result.record && (result.outcome === "pending" || result.outcome === "claimed")) {
        await writeToolExecutionDb(sql, result.record);
      }
      return result;
    }) as Promise<ToolApprovalClaimResult>;
  }

  let result: ToolApprovalClaimResult = { outcome: "not_found" };
  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => {
    const record = ledger.records.find(
      (item) => item.id === input.id && normalizeTenantId(item.tenantId) === tenantId,
    );
    if (!record) {
      result = { outcome: "not_found" };
      return ledger;
    }
    result = applyApprovalClaim(record, input);
    if (!result.record || (result.outcome !== "pending" && result.outcome !== "claimed")) {
      return ledger;
    }
    return replaceLedgerRecord(ledger, result.record);
  });
  return result;
}

export async function rejectPendingToolExecution(input: {
  id: string;
  tenantId?: string;
  rejectedBy: string;
  reason?: string;
}): Promise<{ outcome: "not_found" | "conflict" | "rejected"; record?: ToolExecutionRecord }> {
  const tenantId = normalizeTenantId(input.tenantId);
  const reject = (record: ToolExecutionRecord) => {
    if (record.status !== "approval_required") {
      return { outcome: "conflict" as const, record };
    }
    const now = new Date().toISOString();
    return {
      outcome: "rejected" as const,
      record: {
        ...record,
        status: "rejected" as const,
        approvalDecision: "rejected" as const,
        approvedBy: input.rejectedBy,
        approvedAt: now,
        approvalReason: input.reason
          ? String(redactSensitive(input.reason))
          : undefined,
        reason: input.reason
          ? `Rejected: ${String(redactSensitive(input.reason))}`
          : "Rejected by operator.",
        input: redactSensitive(record.input) as Record<string, unknown>,
        output: undefined,
        completedAt: now,
      },
    };
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE id = ${input.id}
          AND COALESCE(tenant_id, 'default') = ${tenantId}
        FOR UPDATE
      `;
      if (!rows[0]) {
        return { outcome: "not_found" as const };
      }
      const result = reject(recordFromRow(rows[0]));
      if (result.outcome === "rejected") {
        await writeToolExecutionDb(sql, result.record);
      }
      return result;
    }) as Promise<{ outcome: "not_found" | "conflict" | "rejected"; record?: ToolExecutionRecord }>;
  }

  let result: { outcome: "not_found" | "conflict" | "rejected"; record?: ToolExecutionRecord } = {
    outcome: "not_found",
  };
  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => {
    const record = ledger.records.find(
      (item) => item.id === input.id && normalizeTenantId(item.tenantId) === tenantId,
    );
    if (!record) {
      result = { outcome: "not_found" };
      return ledger;
    }
    result = reject(record);
    return result.outcome === "rejected" && result.record
      ? replaceLedgerRecord(ledger, result.record)
      : ledger;
  });
  return result;
}

export async function completeClaimedToolExecution(
  record: ToolExecutionRecord,
  claimToken: string,
  options: { executionScope?: ExecutionScope } = {},
): Promise<ToolExecutionRecord | undefined> {
  const tenantId = normalizeTenantId(record.tenantId);
  const effectReceipt = parseRecordEffectReceipt(record);
  if (effectReceipt && !options.executionScope) {
    throw new Error("Governed tool effect receipts require an execution scope.");
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE id = ${record.id}
          AND COALESCE(tenant_id, 'default') = ${tenantId}
        FOR UPDATE
      `;
      const current = rows[0] ? recordFromRow(rows[0]) : undefined;
      if (!current || !hasExecutionClaim(current, claimToken)) {
        return undefined;
      }
      if (effectReceipt && options.executionScope) {
        assertEffectReceiptFinalization({
          receipt: effectReceipt,
          current,
          terminal: record,
          executionScope: options.executionScope,
        });
      }
      await writeToolExecutionDb(sql, record, {
        finalizeEffectReceipt: Boolean(effectReceipt),
      });
      if (effectReceipt && options.executionScope) {
        await appendToolEffectReceiptEvent(
          effectReceipt,
          options.executionScope,
          sql,
        );
      }
      return record;
    }) as Promise<ToolExecutionRecord | undefined>;
  }

  let completed: ToolExecutionRecord | undefined;
  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => {
    const current = ledger.records.find(
      (item) => item.id === record.id && normalizeTenantId(item.tenantId) === tenantId,
    );
    if (!current || !hasExecutionClaim(current, claimToken)) {
      return ledger;
    }
    if (effectReceipt && options.executionScope) {
      assertEffectReceiptFinalization({
        receipt: effectReceipt,
        current,
        terminal: record,
        executionScope: options.executionScope,
      });
    }
    completed = preserveImmutableEffectReceipt(current, record, {
      finalizeEffectReceipt: Boolean(effectReceipt),
    });
    return replaceLedgerRecord(ledger, completed);
  });
  if (completed && effectReceipt && options.executionScope) {
    try {
      await appendToolEffectReceiptEvent(effectReceipt, options.executionScope);
    } catch {
      // File mode cannot atomically update two ledgers. The authoritative
      // receipt is already durable; a same-key retry repairs this event.
      console.error("Tool effect receipt event append failed in file mode.");
    }
  }
  return completed;
}

export function sealToolExecutionInput(
  input: Record<string, unknown>,
  record: Pick<
    ToolExecutionRecord,
    "id" | "tenantId" | "actorId" | "toolId" | "riskLevel"
  >,
  approvalFingerprint: string,
) {
  return {
    __approvalFingerprint: approvalFingerprint,
    __sealedInput: sealJsonPayload(input, toolExecutionInputBinding(record)),
  };
}

export function openToolExecutionInput(record: ToolExecutionRecord) {
  const value = openJsonPayload(
    parseObject(record.output).__sealedInput,
    toolExecutionInputBinding(record),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The approved execution payload is not a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function getToolExecutionApprovalFingerprint(
  record: ToolExecutionRecord,
) {
  const value = parseObject(record.output).__approvalFingerprint;
  return typeof value === "string" ? value : undefined;
}

function toolExecutionInputBinding(
  record: Pick<
    ToolExecutionRecord,
    "id" | "tenantId" | "actorId" | "toolId" | "riskLevel"
  >,
) {
  return JSON.stringify([
    record.id,
    record.tenantId || "default",
    record.actorId || "",
    record.toolId,
    record.riskLevel,
  ]);
}

export async function failClaimedToolExecution(input: {
  record: ToolExecutionRecord;
  claimToken: string;
  reason: string;
}) {
  const reason = String(redactSensitive(input.reason)).slice(0, 1_000);
  return completeClaimedToolExecution(
    {
      ...input.record,
      status: "failed",
      output: { error: reason },
      reason,
      completedAt: new Date().toISOString(),
    },
    input.claimToken,
  );
}

export async function recoverStaleToolExecutionClaim(
  id: string,
  options: { tenantId?: string; staleAfterMs?: number } = {},
): Promise<ToolExecutionRecord | undefined> {
  const tenantId = normalizeTenantId(options.tenantId);
  const staleAfterMs = Math.max(
    60_000,
    options.staleAfterMs || DEFAULT_STALE_TOOL_EXECUTION_CLAIM_MS,
  );

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE id = ${id}
          AND COALESCE(tenant_id, 'default') = ${tenantId}
        FOR UPDATE
      `;
      const recovered = rows[0]
        ? recoverStaleExecutionRecord(recordFromRow(rows[0]), staleAfterMs)
        : undefined;
      if (recovered) {
        await writeToolExecutionDb(sql, recovered);
      }
      return recovered;
    }) as Promise<ToolExecutionRecord | undefined>;
  }

  let recovered: ToolExecutionRecord | undefined;
  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => {
    const current = ledger.records.find(
      (item) => item.id === id && normalizeTenantId(item.tenantId) === tenantId,
    );
    recovered = current
      ? recoverStaleExecutionRecord(current, staleAfterMs)
      : undefined;
    return recovered ? replaceLedgerRecord(ledger, recovered) : ledger;
  });
  return recovered;
}

export async function recoverStaleToolExecutionClaims(
  options: { tenantId?: string; staleAfterMs?: number; limit?: number } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const staleAfterMs = Math.max(
    60_000,
    options.staleAfterMs || DEFAULT_STALE_TOOL_EXECUTION_CLAIM_MS,
  );
  const limit = Math.min(Math.max(options.limit || 25, 1), 100);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
      const rows = await sql`
        SELECT *
        FROM omni_tool_executions
        WHERE status = 'executing'
          AND COALESCE(tenant_id, 'default') = ${tenantId}
          AND NOT (
            tool_id = 'memory.write'
            AND NOT dry_run
            AND (
              output ? '__effectIdempotencyKeySha256'
              OR output ? '__effectInputSha256'
              OR output ? '__effectPlanSha256'
              OR output ? '__effectTargetId'
              OR output ? '__effectToolContractSha256'
            )
          )
          AND CASE
            WHEN output #>> '{__executionClaim,claimedAt}' ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
            THEN (output #>> '{__executionClaim,claimedAt}')::timestamptz
            ELSE NULL
          END <= ${cutoff}::timestamptz
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `;
      const recovered = rows
        .map(recordFromRow)
        .map((record) => recoverStaleExecutionRecord(record, staleAfterMs))
        .filter(
          (record): record is ToolExecutionRecord => record !== undefined,
        );
      for (const record of recovered) {
        await writeToolExecutionDb(sql, record);
      }
      return recovered.map(sanitizeToolExecutionRecord);
    }) as Promise<ToolExecutionRecord[]>;
  }

  const recovered: ToolExecutionRecord[] = [];
  await updateJsonFile<ToolExecutionLedger>(
    getToolLedgerFile(),
    { records: [] },
    (ledger) => {
      const records = ledger.records.map((record) => {
        if (
          recovered.length >= limit ||
          normalizeTenantId(record.tenantId) !== tenantId
        ) {
          return record;
        }
        const replacement = recoverStaleExecutionRecord(record, staleAfterMs);
        if (replacement) {
          recovered.push(replacement);
          return replacement;
        }
        return record;
      });
      return { records: trimToolExecutionRecords(records) };
    },
  );
  return recovered.map(sanitizeToolExecutionRecord);
}

export async function listToolExecutions(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_tool_executions
      WHERE COALESCE(tenant_id, 'default') = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(recordFromRow).map(sanitizeToolExecutionRecord);
  }

  const ledger = await readToolLedger();
  return ledger.records
    .filter((record) => normalizeTenantId(record.tenantId) === tenantId)
    .slice(0, limit)
    .map(sanitizeToolExecutionRecord);
}

export async function getToolExecution(id: string, options: { tenantId?: string } = {}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_tool_executions
          WHERE id = ${id}
            AND COALESCE(tenant_id, 'default') = ${tenantId}
          LIMIT 1
        `
      : await getSql()`
          SELECT *
          FROM omni_tool_executions
          WHERE id = ${id}
          LIMIT 1
        `;
    return rows[0] ? recordFromRow(rows[0]) : undefined;
  }

  const ledger = await readToolLedger();
  return ledger.records.find(
    (record) => record.id === id && (!options.tenantId || normalizeTenantId(record.tenantId) === normalizeTenantId(options.tenantId)),
  );
}

/**
 * Internal, tenant-scoped lookup for run projections. Unlike the public list
 * helpers, this deliberately retains execution input long enough for a
 * projection to validate an allowlisted receipt; callers must never return
 * the raw records to a client.
 */
export async function getToolExecutionsByIds(
  ids: readonly string[],
  options: { tenantId: string },
) {
  const boundedIds = [...new Set(
    ids.map((id) => id.trim()).filter(Boolean),
  )].slice(0, 200);
  if (!boundedIds.length) return [];
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_tool_executions
      WHERE id = ANY(${boundedIds}::text[])
        AND COALESCE(tenant_id, 'default') = ${tenantId}
    `;
    const recordsById = new Map(
      rows.map((row) => {
        const record = recordFromRow(row);
        return [record.id, record] as const;
      }),
    );
    return boundedIds.flatMap((id) => {
      const record = recordsById.get(id);
      return record ? [record] : [];
    });
  }

  const ledger = await readToolLedger();
  const recordsById = new Map(
    ledger.records
      .filter((record) => normalizeTenantId(record.tenantId) === tenantId)
      .map((record) => [record.id, record] as const),
  );
  return boundedIds.flatMap((id) => {
    const record = recordsById.get(id);
    return record ? [record] : [];
  });
}

export async function listPendingToolApprovals(limit = 25, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, actor_id, tool_id, tool_name, risk_level, status,
        dry_run, approval_required, input, reason, approval_decision,
        approvals, approved_by, approved_at, approval_reason, created_at,
        completed_at
      FROM omni_tool_executions
      WHERE status = 'approval_required'
        AND COALESCE(tenant_id, 'default') = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(recordFromRow).map(sanitizeToolExecutionRecord);
  }

  const ledger = await readToolLedger();
  return ledger.records
    .filter((record) => record.status === "approval_required" && normalizeTenantId(record.tenantId) === tenantId)
    .slice(0, limit)
    .map(sanitizeToolExecutionRecord);
}

export async function getToolExecutionStats(options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_tool_executions
      WHERE COALESCE(tenant_id, 'default') = ${tenantId}
      GROUP BY status
    `;
    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    const riskRows = await getSql()`
      SELECT risk_level, COUNT(*)::int AS count
      FROM omni_tool_executions
      WHERE COALESCE(tenant_id, 'default') = ${tenantId}
      GROUP BY risk_level
    `;
    const byRisk = riskRows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.risk_level)] = Number(row.count);
      return acc;
    }, {});

    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      byRisk,
      latest: await listToolExecutions(5, { tenantId }),
    };
  }

  const ledger = await readToolLedger();
  const records = ledger.records.filter((record) => normalizeTenantId(record.tenantId) === tenantId);
  return {
    total: records.length,
    byStatus: records.reduce<Record<string, number>>((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1;
      return acc;
    }, {}),
    byRisk: records.reduce<Record<string, number>>((acc, record) => {
      acc[String(record.riskLevel)] = (acc[String(record.riskLevel)] || 0) + 1;
      return acc;
    }, {}),
    latest: records.slice(0, 5).map(sanitizeToolExecutionRecord),
  };
}

export function publicToolExecution(record: ToolExecutionRecord) {
  const effectReceipt = parseRecordEffectReceipt(record);
  const sanitized = redactSensitive(record) as ToolExecutionRecord;
  const publicRecord = effectReceipt
    ? { ...omitEffectReceipt(sanitized), effectReceipt }
    : omitEffectReceipt(sanitized);
  if (
    publicRecord.output &&
    typeof publicRecord.output === "object" &&
    !Array.isArray(publicRecord.output)
  ) {
    const publicOutput = {
      ...(publicRecord.output as Record<string, unknown>),
    };
    delete publicOutput.__executionClaim;
    delete publicOutput.__approvalFingerprint;
    delete publicOutput.__sealedInput;
    delete publicOutput.__idempotencyKeyHash;
    delete publicOutput.__effectIdempotencyKeySha256;
    delete publicOutput.__effectInputSha256;
    delete publicOutput.__effectPlanSha256;
    delete publicOutput.__effectTargetId;
    delete publicOutput.__effectToolContractSha256;
    return { ...publicRecord, output: publicOutput };
  }
  return publicRecord;
}

const sanitizeToolExecutionRecord = publicToolExecution;

function parseStoredEffectReceipt(
  value: unknown,
  bindings: {
    executionId: string;
    tenantId: string;
    actorId?: string;
    toolId: string;
  },
): EffectReceiptV1 | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (bindings.toolId !== "memory.write") {
    throw new Error("Only memory.write may carry a v1 effect receipt.");
  }
  return parseEffectReceiptV1(value, {
    executionId: bindings.executionId,
    tenantId: bindings.tenantId,
    ...(bindings.actorId ? { actorId: bindings.actorId } : {}),
    toolId: "memory.write",
  });
}

function parseRecordEffectReceipt(
  record: ToolExecutionRecord,
): EffectReceiptV1 | undefined {
  const receipt = parseStoredEffectReceipt(record.effectReceipt, {
    executionId: record.id,
    tenantId: normalizeTenantId(record.tenantId),
    actorId: record.actorId,
    toolId: record.toolId,
  });
  if (!receipt) return undefined;
  if (
    record.status !== "executed" ||
    record.dryRun ||
    !record.tenantId?.trim() ||
    !record.actorId?.trim()
  ) {
    throw new Error(
      "An effect receipt requires an executed live record with explicit tenant and actor scope.",
    );
  }
  return receipt;
}

function omitEffectReceipt(record: ToolExecutionRecord): ToolExecutionRecord {
  const { effectReceipt: _effectReceipt, ...legacyRecord } = record;
  void _effectReceipt;
  return legacyRecord;
}

function assertEffectReceiptFinalization(input: {
  receipt: EffectReceiptV1;
  current: ToolExecutionRecord;
  terminal: ToolExecutionRecord;
  executionScope: ExecutionScope;
}) {
  const { receipt, current, terminal, executionScope } = input;
  const actorId = executionScope.initiatingActorId;
  if (!actorId) {
    throw new Error("Effect-receipt finalization requires a bound actor.");
  }
  const validated = parseEffectReceiptV1(receipt, {
    executionId: current.id,
    tenantId: executionScope.tenantId,
    actorId,
    executingPrincipalType: "system",
    executingPrincipalId: `workflow:${receipt.workflowRunId}`,
    toolId: "memory.write",
  });
  if (!validated) throw new Error("Effect receipt is missing.");
  if (
    normalizeTenantId(current.tenantId) !== validated.tenantId ||
    current.actorId !== validated.actorId ||
    current.toolId !== validated.toolId ||
    terminal.id !== current.id ||
    normalizeTenantId(terminal.tenantId) !== validated.tenantId ||
    terminal.actorId !== validated.actorId ||
    terminal.toolId !== validated.toolId
  ) {
    throw new Error(
      "Effect-receipt finalization does not match the claimed tool execution.",
    );
  }
  const expectedCausationId = `workflow.tool:${createHash("sha256")
    .update([
      validated.workflowRunId,
      validated.planId,
      validated.planNodeId,
      validated.toolId,
    ].join("\0"))
    .digest("hex")}`;
  if (
    executionScope.executingPrincipalType !== "system" ||
    executionScope.executingPrincipalId !== validated.executingPrincipalId ||
    executionScope.causationId !== expectedCausationId
  ) {
    throw new Error(
      "Effect-receipt workflow bindings do not match the execution scope.",
    );
  }
  if (
    toolInputSha256(current.input) !== validated.inputSha256 ||
    toolInputSha256(terminal.input) !== validated.inputSha256
  ) {
    throw new Error("Effect-receipt input does not match the claimed input.");
  }
  const claimedIdempotencySha256 =
    parseObject(current.output).__effectIdempotencyKeySha256;
  const claimedInputSha256 = parseObject(current.output).__effectInputSha256;
  const claimedPlanSha256 = parseObject(current.output).__effectPlanSha256;
  const claimedTargetId = parseObject(current.output).__effectTargetId;
  const claimedToolContractSha256 =
    parseObject(current.output).__effectToolContractSha256;
  if (
    claimedIdempotencySha256 !== validated.idempotencyKeySha256 ||
    claimedInputSha256 !== validated.inputSha256 ||
    claimedPlanSha256 !== validated.planSha256 ||
    claimedTargetId !== validated.targetId ||
    claimedToolContractSha256 !== validated.toolContractSha256
  ) {
    throw new Error(
      "Effect-receipt identity was not fully bound before execution.",
    );
  }
  const tool = getGovernedTool(validated.toolId);
  const expectedToolContractSha256 = tool
    ? canonicalJsonSha256({
        approvalFingerprint: toolApprovalFingerprint(tool),
      })
    : undefined;
  if (expectedToolContractSha256 !== validated.toolContractSha256) {
    throw new Error(
      "Effect-receipt tool contract does not match the executing release.",
    );
  }
  const expectedTargetId = memoryEffectTargetIdV1({
    tenantId: validated.tenantId,
    executionId: validated.executionId,
    workflowRunId: validated.workflowRunId,
    planId: validated.planId,
    planSha256: validated.planSha256,
    planNodeId: validated.planNodeId,
    inputSha256: validated.inputSha256,
    idempotencyKeySha256: validated.idempotencyKeySha256,
  });
  if (validated.targetId !== expectedTargetId) {
    throw new Error(
      "Effect-receipt target does not match its deterministic execution binding.",
    );
  }
}

async function appendToolEffectReceiptEvent(
  receipt: EffectReceiptV1,
  executionScope: ExecutionScope,
  sql?: SqlClient,
) {
  if (
    !executionScope.initiatingActorId ||
    executionScope.executingPrincipalType !== "system" ||
    !executionScope.executingPrincipalId
  ) {
    throw new Error(
      "Effect-receipt events require a bound actor and system principal.",
    );
  }
  const validated = parseEffectReceiptV1(receipt, {
    executionId: receipt.executionId,
    tenantId: executionScope.tenantId,
    actorId: executionScope.initiatingActorId,
    executingPrincipalType: executionScope.executingPrincipalType,
    executingPrincipalId: executionScope.executingPrincipalId,
    toolId: "memory.write",
  });
  if (!validated) {
    throw new Error("Effect-receipt event is missing its receipt.");
  }
  await appendScopedDomainEvent({
    id: `tool.effect_receipt:${validated.effectReceiptId}`,
    streamId: `tool_execution:${validated.executionId}`,
    type: "tool.effect_receipt.recorded",
    executionScope,
    payload: buildEffectReceiptEventPayloadV1(validated),
  }, sql ? { sql } : {});
}

export async function repairFileToolEffectReceiptEvent(
  record: ToolExecutionRecord,
  executionScope?: ExecutionScope,
) {
  const receipt = parseRecordEffectReceipt(record);
  if (!receipt || hasDatabaseUrl()) return;
  if (!executionScope) {
    throw new Error("Effect-receipt event repair requires an execution scope.");
  }
  try {
    await appendToolEffectReceiptEvent(receipt, executionScope);
  } catch {
    console.error("Tool effect receipt event repair failed in file mode.");
  }
}

async function readToolLedger() {
  return readJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] });
}

function getToolLedgerFile() {
  return getDataPath("tools.json");
}

function applyApprovalClaim(
  record: ToolExecutionRecord,
  input: {
    approvedBy: string;
    approvedRole: string;
    approvalReason?: string;
    claimToken: string;
  },
): ToolApprovalClaimResult {
  if (record.status !== "approval_required") {
    return { outcome: "conflict", record };
  }
  const approvalReason = input.approvalReason
    ? String(redactSensitive(input.approvalReason)).slice(0, 1_000)
    : undefined;

  let approvals = record.approvals || [];
  if (record.riskLevel >= 3) {
    if (
      (input.approvedRole !== "admin" && input.approvedRole !== "system") ||
      input.approvedBy === record.actorId
    ) {
      return { outcome: "conflict", record };
    }
    approvals = [
      ...approvals.filter((approval) => approval.by !== input.approvedBy),
      {
        by: input.approvedBy,
        role: input.approvedRole,
        at: new Date().toISOString(),
        reason: approvalReason,
      },
    ];
    if (!hasRisk3ApprovalQuorum(record, approvals)) {
      return {
        outcome: "pending",
        record: {
          ...record,
          approvals,
        },
      };
    }
  }

  const now = new Date().toISOString();
  const internalOutput = parseObject(record.output);
  const sealedInput = internalOutput.__sealedInput;
  const approvalFingerprint = internalOutput.__approvalFingerprint;
  return {
    outcome: "claimed",
    record: {
      ...record,
      status: "executing",
      approvals,
      approvalDecision: "approved",
      approvedBy: input.approvedBy,
      approvedAt: now,
      approvalReason,
      completedAt: undefined,
      output: {
        ...(approvalFingerprint
          ? { __approvalFingerprint: approvalFingerprint }
          : {}),
        ...(sealedInput ? { __sealedInput: sealedInput } : {}),
        __executionClaim: {
          token: input.claimToken,
          claimedAt: now,
        },
      },
    },
  };
}

function hasRisk3ApprovalQuorum(
  record: ToolExecutionRecord,
  approvals: NonNullable<ToolExecutionRecord["approvals"]>,
) {
  return new Set(
    approvals
      .filter(
        (approval) =>
          (approval.role === "admin" || approval.role === "system") &&
          approval.by !== record.actorId,
      )
      .map((approval) => approval.by),
  ).size >= RISK3_QUORUM;
}

function executionClaimFrom(record: ToolExecutionRecord) {
  const output = parseObject(record.output);
  const claim = parseObject(output.__executionClaim);
  const token = typeof claim.token === "string" ? claim.token : "";
  const claimedAt = typeof claim.claimedAt === "string" ? claim.claimedAt : "";
  return token && claimedAt ? { token, claimedAt } : undefined;
}

type EffectExecutionIntentBinding = Readonly<{
  idempotencyKeySha256: string;
  inputSha256: string;
  planSha256: string;
  targetId: string;
  toolContractSha256: string;
}>;

function effectExecutionIntentBindingFrom(
  record: ToolExecutionRecord,
): EffectExecutionIntentBinding | undefined {
  if (
    record.toolId !== "memory.write" ||
    record.status !== "executing" ||
    record.dryRun ||
    record.effectReceipt !== undefined
  ) {
    return undefined;
  }
  const output = parseObject(record.output);
  const binding = {
    idempotencyKeySha256: output.__effectIdempotencyKeySha256,
    inputSha256: output.__effectInputSha256,
    planSha256: output.__effectPlanSha256,
    targetId: output.__effectTargetId,
    toolContractSha256: output.__effectToolContractSha256,
  };
  if (
    !isSha256(binding.idempotencyKeySha256) ||
    !isSha256(binding.inputSha256) ||
    !isSha256(binding.planSha256) ||
    typeof binding.targetId !== "string" ||
    !binding.targetId.startsWith("memory_effect_") ||
    !isSha256(binding.toolContractSha256)
  ) {
    return undefined;
  }
  return binding as EffectExecutionIntentBinding;
}

function isEffectBoundExecutionIntent(record: ToolExecutionRecord) {
  const output = parseObject(record.output);
  return record.toolId === "memory.write" &&
    record.status === "executing" &&
    !record.dryRun &&
    [
      "__effectIdempotencyKeySha256",
      "__effectInputSha256",
      "__effectPlanSha256",
      "__effectTargetId",
      "__effectToolContractSha256",
    ].some((key) => Object.hasOwn(output, key));
}

function reclaimStaleEffectExecutionRecord(
  existing: ToolExecutionRecord,
  proposed: ToolExecutionRecord,
  staleAfterMs = DEFAULT_STALE_TOOL_EXECUTION_CLAIM_MS,
) {
  const existingClaim = executionClaimFrom(existing);
  const proposedClaim = executionClaimFrom(proposed);
  const existingBinding = effectExecutionIntentBindingFrom(existing);
  const proposedBinding = effectExecutionIntentBindingFrom(proposed);
  if (
    !existingClaim ||
    !proposedClaim ||
    !existingBinding ||
    !proposedBinding ||
    !Number.isFinite(Date.parse(existingClaim.claimedAt)) ||
    Date.now() - Date.parse(existingClaim.claimedAt) < staleAfterMs ||
    normalizeTenantId(existing.tenantId) !== normalizeTenantId(proposed.tenantId) ||
    existing.actorId !== proposed.actorId ||
    existing.toolId !== proposed.toolId ||
    existing.riskLevel !== proposed.riskLevel ||
    toolInputSha256(existing.input) !== toolInputSha256(proposed.input) ||
    canonicalJsonSha256(existingBinding) !== canonicalJsonSha256(proposedBinding)
  ) {
    return undefined;
  }
  return {
    ...existing,
    output: {
      ...parseObject(existing.output),
      __executionClaim: {
        token: proposedClaim.token,
        claimedAt: proposedClaim.claimedAt,
      },
    },
    reason: proposed.reason,
    completedAt: undefined,
  } satisfies ToolExecutionRecord;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function recoverStaleExecutionRecord(
  record: ToolExecutionRecord,
  staleAfterMs: number,
): ToolExecutionRecord | undefined {
  const claim = executionClaimFrom(record);
  if (
    record.status !== "executing" ||
    isEffectBoundExecutionIntent(record) ||
    !claim ||
    !Number.isFinite(new Date(claim.claimedAt).getTime()) ||
    Date.now() - new Date(claim.claimedAt).getTime() < staleAfterMs
  ) {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    ...record,
    status: "failed" as const,
    output: {
      error:
        "Execution claim expired before a terminal result was recorded; outcome may be unknown.",
      idempotencyKey: record.id,
    },
    reason: "Stale execution claim recovered without replaying the side effect.",
    completedAt: now,
  };
}

function hasExecutionClaim(record: ToolExecutionRecord, claimToken: string) {
  const claim = executionClaimFrom(record);
  return record.status === "executing" && claim?.token === claimToken;
}

function replaceLedgerRecord(ledger: ToolExecutionLedger, record: ToolExecutionRecord): ToolExecutionLedger {
  return {
    records: trimToolExecutionRecords([
      record,
      ...ledger.records.filter((item) => item.id !== record.id),
    ]),
  };
}

function preserveImmutableEffectReceipt(
  existing: ToolExecutionRecord | undefined,
  next: ToolExecutionRecord,
  options: { finalizeEffectReceipt?: boolean } = {},
) {
  const existingReceipt = existing
    ? parseRecordEffectReceipt(existing)
    : undefined;
  const nextReceipt = parseRecordEffectReceipt(next);
  if (nextReceipt && !options.finalizeEffectReceipt) {
    throw new Error(
      "A generic tool-execution write cannot attach an effect receipt.",
    );
  }
  if (!existingReceipt) return next;
  if (!options.finalizeEffectReceipt) {
    throw new Error(
      "A generic tool-execution write cannot mutate a receipt-bearing record.",
    );
  }
  if (
    nextReceipt &&
    nextReceipt.receiptSha256 !== existingReceipt.receiptSha256
  ) {
    throw new Error("A persisted effect receipt is immutable.");
  }
  if (next.status !== "executed" || next.dryRun) {
    throw new Error(
      "A tool execution carrying an effect receipt must remain a live executed record.",
    );
  }
  return { ...next, effectReceipt: existingReceipt };
}

function trimToolExecutionRecords(records: ToolExecutionRecord[]) {
  const durable = records.filter(
    (record) => record.status === "approval_required" || record.status === "executing",
  );
  const terminal = records.filter(
    (record) => record.status !== "approval_required" && record.status !== "executing",
  );
  return [...durable, ...terminal.slice(0, Math.max(0, 250 - durable.length))];
}

async function writeToolExecutionDb(
  sql: SqlClient,
  record: ToolExecutionRecord,
  options: { finalizeEffectReceipt?: boolean } = {},
) {
  const effectReceipt = parseRecordEffectReceipt(record);
  if (effectReceipt && !options.finalizeEffectReceipt) {
    throw new Error(
      "A generic tool-execution write cannot attach an effect receipt.",
    );
  }
  const rows = await sql`
    INSERT INTO omni_tool_executions (
      id, tool_id, tool_name, risk_level, status, dry_run, approval_required,
      tenant_id, actor_id, input, output, reason, approval_decision, approvals, approved_by,
      approved_at, approval_reason, effect_receipt, created_at, completed_at
    )
    VALUES (
      ${record.id}, ${record.toolId}, ${record.toolName}, ${record.riskLevel}, ${record.status},
      ${record.dryRun}, ${record.approvalRequired}, ${record.tenantId || null}, ${record.actorId || null},
      ${record.input}::jsonb, ${record.output ?? null}::jsonb,
      ${record.reason || null}, ${record.approvalDecision || null},
      ${record.approvals || null}::jsonb, ${record.approvedBy || null},
      ${record.approvedAt || null}, ${record.approvalReason || null},
      ${record.effectReceipt || null}::jsonb, ${record.createdAt},
      ${record.completedAt || null}
    )
    ON CONFLICT (id) DO UPDATE SET
      tool_id = EXCLUDED.tool_id,
      tool_name = EXCLUDED.tool_name,
      risk_level = EXCLUDED.risk_level,
      status = EXCLUDED.status,
      dry_run = EXCLUDED.dry_run,
      approval_required = EXCLUDED.approval_required,
      tenant_id = EXCLUDED.tenant_id,
      actor_id = EXCLUDED.actor_id,
      input = EXCLUDED.input,
      output = EXCLUDED.output,
      reason = EXCLUDED.reason,
      approval_decision = EXCLUDED.approval_decision,
      approvals = EXCLUDED.approvals,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      approval_reason = EXCLUDED.approval_reason,
      effect_receipt = CASE
        WHEN ${options.finalizeEffectReceipt === true}
          THEN EXCLUDED.effect_receipt
        ELSE omni_tool_executions.effect_receipt
      END,
      completed_at = EXCLUDED.completed_at
    WHERE omni_tool_executions.effect_receipt IS NULL
      OR (
        ${options.finalizeEffectReceipt === true}
        AND
        EXCLUDED.status = 'executed'
        AND NOT EXCLUDED.dry_run
        AND omni_tool_executions.effect_receipt = EXCLUDED.effect_receipt
      )
    RETURNING id
  `;
  if (!rows[0]) {
    throw new Error(
      "The tool-execution update would replace, erase, or invalidate an immutable effect receipt.",
    );
  }
}

function recordFromRow(row: Record<string, unknown>): ToolExecutionRecord {
  const record: ToolExecutionRecord = {
    id: String(row.id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    toolId: String(row.tool_id),
    toolName: String(row.tool_name),
    riskLevel: Number(row.risk_level) as ToolExecutionRecord["riskLevel"],
    status: String(row.status) as ToolExecutionRecord["status"],
    dryRun: Boolean(row.dry_run),
    approvalRequired: Boolean(row.approval_required),
    input: parseObject(row.input),
    output: row.output,
    reason: row.reason ? String(row.reason) : undefined,
    approvalDecision: row.approval_decision ? String(row.approval_decision) as ToolExecutionRecord["approvalDecision"] : undefined,
    approvals: Array.isArray(row.approvals) ? (row.approvals as ToolExecutionRecord["approvals"]) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? normalizeDate(row.approved_at) : undefined,
    approvalReason: row.approval_reason ? String(row.approval_reason) : undefined,
    createdAt: normalizeDate(row.created_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
  };
  const effectReceipt = parseStoredEffectReceipt(
    row.effect_receipt === null ? undefined : row.effect_receipt,
    {
      executionId: record.id,
      tenantId: normalizeTenantId(record.tenantId),
      actorId: record.actorId,
      toolId: record.toolId,
    },
  );
  return preserveImmutableEffectReceipt(
    undefined,
    effectReceipt ? { ...record, effectReceipt } : record,
    { finalizeEffectReceipt: Boolean(effectReceipt) },
  );
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
