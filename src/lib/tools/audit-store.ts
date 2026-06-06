import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import type { ToolExecutionLedger, ToolExecutionRecord } from "@/lib/tools/types";

let fileWriteQueue: Promise<void> = Promise.resolve();

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
    await getSql()`
      INSERT INTO omni_tool_executions (
        id, tool_id, tool_name, risk_level, status, dry_run, approval_required,
        tenant_id, actor_id, input, output, reason, approval_decision, approved_by,
        approved_at, approval_reason, created_at, completed_at
      )
      VALUES (
        ${record.id}, ${record.toolId}, ${record.toolName}, ${record.riskLevel}, ${record.status},
        ${record.dryRun}, ${record.approvalRequired}, ${record.tenantId || null}, ${record.actorId || null},
        ${JSON.stringify(record.input)}::jsonb, ${JSON.stringify(record.output ?? null)}::jsonb,
        ${record.reason || null}, ${record.approvalDecision || null}, ${record.approvedBy || null},
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
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        approval_reason = EXCLUDED.approval_reason,
        completed_at = EXCLUDED.completed_at
    `;
    return record;
  }

  fileWriteQueue = fileWriteQueue.then(
    async () => {
      const ledger = await readToolLedger();
      ledger.records = [record, ...ledger.records.filter((item) => item.id !== record.id)];
      await writeToolLedger(ledger);
    },
    async () => {
      const ledger = await readToolLedger();
      ledger.records = [record, ...ledger.records.filter((item) => item.id !== record.id)];
      await writeToolLedger(ledger);
    },
  );
  await fileWriteQueue;
  return record;
}

export async function listToolExecutions(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_tool_executions
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(recordFromRow);
  }

  const ledger = await readToolLedger();
  return ledger.records.slice(0, limit);
}

export async function getToolExecution(id: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_tool_executions
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? recordFromRow(rows[0]) : undefined;
  }

  const ledger = await readToolLedger();
  return ledger.records.find((record) => record.id === id);
}

export async function listPendingToolApprovals(limit = 25) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_tool_executions
      WHERE status = 'approval_required'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(recordFromRow);
  }

  const ledger = await readToolLedger();
  return ledger.records
    .filter((record) => record.status === "approval_required")
    .slice(0, limit);
}

export async function getToolExecutionStats() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_tool_executions
      GROUP BY status
    `;
    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    const riskRows = await getSql()`
      SELECT risk_level, COUNT(*)::int AS count
      FROM omni_tool_executions
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
      latest: await listToolExecutions(5),
    };
  }

  const ledger = await readToolLedger();
  return {
    total: ledger.records.length,
    byStatus: ledger.records.reduce<Record<string, number>>((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1;
      return acc;
    }, {}),
    byRisk: ledger.records.reduce<Record<string, number>>((acc, record) => {
      acc[String(record.riskLevel)] = (acc[String(record.riskLevel)] || 0) + 1;
      return acc;
    }, {}),
    latest: ledger.records.slice(0, 5),
  };
}

async function readToolLedger() {
  return readJsonFile<ToolExecutionLedger>(getToolLedgerFile(), { records: [] });
}

async function writeToolLedger(ledger: ToolExecutionLedger) {
  await writeJsonFile(getToolLedgerFile(), {
    records: ledger.records.slice(0, 250),
  });
}

function getToolLedgerFile() {
  return getDataPath("tools.json");
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
