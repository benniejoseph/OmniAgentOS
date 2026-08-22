import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import {
  openJsonPayload,
  sealJsonPayload,
} from "@/lib/security/sealed-payload";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { RISK3_QUORUM, type ToolExecutionLedger, type ToolExecutionRecord } from "@/lib/tools/types";

type SqlClient = ReturnType<typeof getSql>;

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
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await writeToolExecutionDb(getSql(), record);
    return record;
  }

  await updateJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] }, (ledger) => ({
    records: trimToolExecutionRecords([
      record,
      ...ledger.records.filter((item) => item.id !== record.id),
    ]),
  }));
  return record;
}

export async function claimIdempotentToolExecution(
  record: ToolExecutionRecord,
): Promise<IdempotentToolExecutionClaimResult> {
  const tenantId = normalizeTenantId(record.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: SqlClient) => {
      const inserted = await sql`
        INSERT INTO omni_tool_executions (
          id, tool_id, tool_name, risk_level, status, dry_run,
          approval_required, tenant_id, actor_id, input, output, reason,
          approval_decision, approvals, approved_by, approved_at,
          approval_reason, created_at, completed_at
        )
        VALUES (
          ${record.id}, ${record.toolId}, ${record.toolName},
          ${record.riskLevel}, ${record.status}, ${record.dryRun},
          ${record.approvalRequired}, ${record.tenantId || null},
          ${record.actorId || null}, ${JSON.stringify(record.input)}::jsonb,
          ${JSON.stringify(record.output ?? null)}::jsonb,
          ${record.reason || null}, ${record.approvalDecision || null},
          ${record.approvals ? JSON.stringify(record.approvals) : null}::jsonb,
          ${record.approvedBy || null}, ${record.approvedAt || null},
          ${record.approvalReason || null}, ${record.createdAt},
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
      return {
        outcome: "existing" as const,
        record: recordFromRow(rows[0]),
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
): Promise<ToolExecutionRecord | undefined> {
  const tenantId = normalizeTenantId(record.tenantId);

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
      await writeToolExecutionDb(sql, record);
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
    completed = record;
    return replaceLedgerRecord(ledger, record);
  });
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
  const staleAfterMs = Math.max(60_000, options.staleAfterMs || 5 * 60_000);

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
  const staleAfterMs = Math.max(60_000, options.staleAfterMs || 5 * 60_000);
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

export async function listPendingToolApprovals(limit = 25, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
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
  const sanitized = redactSensitive(record) as ToolExecutionRecord;
  if (
    sanitized.output &&
    typeof sanitized.output === "object" &&
    !Array.isArray(sanitized.output)
  ) {
    const publicOutput = {
      ...(sanitized.output as Record<string, unknown>),
    };
    delete publicOutput.__executionClaim;
    delete publicOutput.__approvalFingerprint;
    delete publicOutput.__sealedInput;
    delete publicOutput.__idempotencyKeyHash;
    return { ...sanitized, output: publicOutput };
  }
  return sanitized;
}

const sanitizeToolExecutionRecord = publicToolExecution;

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

function recoverStaleExecutionRecord(
  record: ToolExecutionRecord,
  staleAfterMs: number,
): ToolExecutionRecord | undefined {
  const claim = executionClaimFrom(record);
  if (
    record.status !== "executing" ||
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

function trimToolExecutionRecords(records: ToolExecutionRecord[]) {
  const durable = records.filter(
    (record) => record.status === "approval_required" || record.status === "executing",
  );
  const terminal = records.filter(
    (record) => record.status !== "approval_required" && record.status !== "executing",
  );
  return [...durable, ...terminal.slice(0, Math.max(0, 250 - durable.length))];
}

async function writeToolExecutionDb(sql: SqlClient, record: ToolExecutionRecord) {
  await sql`
    INSERT INTO omni_tool_executions (
      id, tool_id, tool_name, risk_level, status, dry_run, approval_required,
      tenant_id, actor_id, input, output, reason, approval_decision, approvals, approved_by,
      approved_at, approval_reason, created_at, completed_at
    )
    VALUES (
      ${record.id}, ${record.toolId}, ${record.toolName}, ${record.riskLevel}, ${record.status},
      ${record.dryRun}, ${record.approvalRequired}, ${record.tenantId || null}, ${record.actorId || null},
      ${JSON.stringify(record.input)}::jsonb, ${JSON.stringify(record.output ?? null)}::jsonb,
      ${record.reason || null}, ${record.approvalDecision || null},
      ${record.approvals ? JSON.stringify(record.approvals) : null}::jsonb, ${record.approvedBy || null},
      ${record.approvedAt || null}, ${record.approvalReason || null}, ${record.createdAt},
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
      completed_at = EXCLUDED.completed_at
  `;
}

function recordFromRow(row: Record<string, unknown>): ToolExecutionRecord {
  return {
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
