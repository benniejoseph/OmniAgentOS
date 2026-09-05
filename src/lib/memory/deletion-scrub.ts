import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  createExecutionScope,
  deriveExecutionScope,
  parsePersistedExecutionScope,
} from "@/lib/security/execution-scope";

const DEFAULT_SCRUB_SLA_HOURS = 24;
const DEFAULT_RECEIPT_LIMIT = 10;
const DEFAULT_MEMORY_LIMIT = 100;

type MemoryDeletionScrubReceiptRow = Record<string, unknown> & {
  id: unknown;
  tenant_id: unknown;
  memory_id: unknown;
  descendant_memory_ids: unknown;
  descendant_memory_count: unknown;
  attribution_kind: unknown;
  execution_scope: unknown;
  forgotten_at: unknown;
  created_at: unknown;
};

export type MemoryDeletionScrubResult = {
  backend: "postgres" | "bounded_local";
  processedReceipts: number;
  scrubbedMemories: number;
  completedReceiptIds: string[];
  overdueReceiptIds: string[];
  hasMore: boolean;
  slaHours: number;
  completedAt: string;
};

/**
 * Physically scrubs descendants already hidden by an immutable deletion
 * receipt. The receipt itself is the durable work manifest, so a crash leaves
 * the remaining rows discoverable on the next maintenance tick.
 */
export async function processPendingMemoryDeletionScrubs({
  receiptLimit = DEFAULT_RECEIPT_LIMIT,
  memoryLimit = DEFAULT_MEMORY_LIMIT,
}: {
  receiptLimit?: number;
  memoryLimit?: number;
} = {}): Promise<MemoryDeletionScrubResult> {
  const boundedReceiptLimit = Math.min(Math.max(Math.trunc(receiptLimit), 1), 50);
  const boundedMemoryLimit = Math.min(Math.max(Math.trunc(memoryLimit), 1), 500);
  const slaHours = memoryDeletionScrubSlaHours();

  if (!hasDatabaseUrl()) {
    return {
      backend: "bounded_local",
      processedReceipts: 0,
      scrubbedMemories: 0,
      completedReceiptIds: [],
      overdueReceiptIds: [],
      hasMore: false,
      slaHours,
      completedAt: new Date().toISOString(),
    };
  }

  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope(
    "Physically scrub memory descendants protected by immutable deletion receipts.",
    async () => {
      const sql = getSql();
      const vectorColumnRows = await sql`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND column_name = 'embedding_vector'
        LIMIT 1
      `;
      const hasVectorColumn = Boolean(vectorColumnRows[0]);

      return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
        const receiptRows = await transaction`
          SELECT receipt.*
          FROM omni_memory_deletion_receipts receipt
          WHERE cardinality(receipt.descendant_memory_ids) > 0
            AND EXISTS (
              SELECT 1
              FROM omni_memories memory
              WHERE memory.tenant_id = receipt.tenant_id
                AND memory.id = ANY(receipt.descendant_memory_ids)
                AND (
                  memory.title IS DISTINCT FROM '[forgotten]'
                  OR memory.content IS DISTINCT FROM ''
                  OR memory.tags IS DISTINCT FROM '{}'::text[]
                  OR memory.source IS DISTINCT FROM '[forgotten]'
                  OR memory.embedding IS NOT NULL
                  OR memory.evidence_refs IS DISTINCT FROM '{}'::text[]
                  OR memory.supersedes_id IS NOT NULL
                  OR memory.contradiction_of_id IS NOT NULL
                  OR memory.claim_status IS DISTINCT FROM 'forgotten'
                  OR memory.forgotten_at IS NULL
                )
            )
          ORDER BY receipt.created_at ASC, receipt.tenant_id ASC, receipt.id ASC
          FOR UPDATE OF receipt SKIP LOCKED
          LIMIT ${boundedReceiptLimit}
        ` as MemoryDeletionScrubReceiptRow[];

        let remainingMemoryBudget = boundedMemoryLimit;
        let scrubbedMemories = 0;
        const completedReceiptIds: string[] = [];
        const overdueReceiptIds: string[] = [];
        let hasIncompleteReceipt = false;

        for (const row of receiptRows) {
          if (remainingMemoryBudget <= 0) {
            hasIncompleteReceipt = true;
            break;
          }
          const receipt = scrubReceiptFromRow(row);
          if (isPastScrubSla(receipt.createdAt, slaHours)) {
            overdueReceiptIds.push(receipt.id);
          }

          const scrubbedRows = hasVectorColumn
            ? await transaction`
                WITH candidates AS (
                  SELECT memory.ctid
                  FROM omni_memories memory
                  WHERE memory.tenant_id = ${receipt.tenantId}
                    AND memory.id = ANY(${receipt.descendantMemoryIds}::text[])
                    AND (
                      memory.title IS DISTINCT FROM '[forgotten]'
                      OR memory.content IS DISTINCT FROM ''
                      OR memory.tags IS DISTINCT FROM '{}'::text[]
                      OR memory.source IS DISTINCT FROM '[forgotten]'
                      OR memory.embedding IS NOT NULL
                      OR memory.embedding_vector IS NOT NULL
                      OR memory.evidence_refs IS DISTINCT FROM '{}'::text[]
                      OR memory.supersedes_id IS NOT NULL
                      OR memory.contradiction_of_id IS NOT NULL
                      OR memory.claim_status IS DISTINCT FROM 'forgotten'
                      OR memory.forgotten_at IS NULL
                    )
                  ORDER BY array_position(${receipt.descendantMemoryIds}::text[], memory.id)
                  FOR UPDATE SKIP LOCKED
                  LIMIT ${remainingMemoryBudget}
                )
                UPDATE omni_memories memory
                SET title = '[forgotten]',
                    content = '',
                    tags = '{}'::text[],
                    source = '[forgotten]',
                    embedding = NULL,
                    embedding_vector = NULL,
                    evidence_refs = '{}'::text[],
                    supersedes_id = NULL,
                    contradiction_of_id = NULL,
                    claim_status = 'forgotten',
                    forgotten_at = COALESCE(memory.forgotten_at, ${receipt.forgottenAt}),
                    updated_at = ${receipt.forgottenAt}
                FROM candidates
                WHERE memory.ctid = candidates.ctid
                RETURNING memory.id
              `
            : await transaction`
                WITH candidates AS (
                  SELECT memory.ctid
                  FROM omni_memories memory
                  WHERE memory.tenant_id = ${receipt.tenantId}
                    AND memory.id = ANY(${receipt.descendantMemoryIds}::text[])
                    AND (
                      memory.title IS DISTINCT FROM '[forgotten]'
                      OR memory.content IS DISTINCT FROM ''
                      OR memory.tags IS DISTINCT FROM '{}'::text[]
                      OR memory.source IS DISTINCT FROM '[forgotten]'
                      OR memory.embedding IS NOT NULL
                      OR memory.evidence_refs IS DISTINCT FROM '{}'::text[]
                      OR memory.supersedes_id IS NOT NULL
                      OR memory.contradiction_of_id IS NOT NULL
                      OR memory.claim_status IS DISTINCT FROM 'forgotten'
                      OR memory.forgotten_at IS NULL
                    )
                  ORDER BY array_position(${receipt.descendantMemoryIds}::text[], memory.id)
                  FOR UPDATE SKIP LOCKED
                  LIMIT ${remainingMemoryBudget}
                )
                UPDATE omni_memories memory
                SET title = '[forgotten]',
                    content = '',
                    tags = '{}'::text[],
                    source = '[forgotten]',
                    embedding = NULL,
                    evidence_refs = '{}'::text[],
                    supersedes_id = NULL,
                    contradiction_of_id = NULL,
                    claim_status = 'forgotten',
                    forgotten_at = COALESCE(memory.forgotten_at, ${receipt.forgottenAt}),
                    updated_at = ${receipt.forgottenAt}
                FROM candidates
                WHERE memory.ctid = candidates.ctid
                RETURNING memory.id
              `;
          remainingMemoryBudget -= scrubbedRows.length;
          scrubbedMemories += scrubbedRows.length;

          const remainingRows = await transaction`
            SELECT EXISTS (
              SELECT 1
              FROM omni_memories memory
              WHERE memory.tenant_id = ${receipt.tenantId}
                AND memory.id = ANY(${receipt.descendantMemoryIds}::text[])
                AND (
                  memory.title IS DISTINCT FROM '[forgotten]'
                  OR memory.content IS DISTINCT FROM ''
                  OR memory.tags IS DISTINCT FROM '{}'::text[]
                  OR memory.source IS DISTINCT FROM '[forgotten]'
                  OR memory.embedding IS NOT NULL
                  OR memory.evidence_refs IS DISTINCT FROM '{}'::text[]
                  OR memory.supersedes_id IS NOT NULL
                  OR memory.contradiction_of_id IS NOT NULL
                  OR memory.claim_status IS DISTINCT FROM 'forgotten'
                  OR memory.forgotten_at IS NULL
                )
            ) AS pending
          `;
          const pending = Boolean(remainingRows[0]?.pending);
          hasIncompleteReceipt ||= pending;
          if (pending) continue;

          completedReceiptIds.push(receipt.id);
          const executionScope = deletionScrubExecutionScope(receipt);
          await appendScopedDomainEvent({
            id: memoryDeletionScrubEventId(receipt.tenantId, receipt.id),
            streamId: `memory:${receipt.memoryId}`,
            type: "memory.deletion_scrub.completed",
            executionScope,
            payload: {
              schemaVersion: 1,
              deletionReceiptId: receipt.id,
              memoryId: receipt.memoryId,
              descendantMemoryCount: receipt.descendantMemoryCount,
              status: "physical_scrub_completed",
              completedWithinSla: !isPastScrubSla(receipt.createdAt, slaHours),
              scrubSlaHours: slaHours,
            },
          }, { sql: transaction });
        }

        return {
          backend: "postgres" as const,
          processedReceipts: receiptRows.length,
          scrubbedMemories,
          completedReceiptIds,
          overdueReceiptIds,
          hasMore:
            hasIncompleteReceipt || receiptRows.length === boundedReceiptLimit,
          slaHours,
          completedAt: new Date().toISOString(),
        };
      }) as Promise<MemoryDeletionScrubResult>;
    },
  );
}

export function memoryDeletionScrubSlaHours() {
  const parsed = Number.parseInt(
    process.env.OMNIAGENT_MEMORY_DELETION_SCRUB_SLA_HOURS || "",
    10,
  );
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), 720)
    : DEFAULT_SCRUB_SLA_HOURS;
}

function isPastScrubSla(createdAt: string, slaHours: number) {
  return Date.now() > Date.parse(createdAt) + slaHours * 60 * 60 * 1_000;
}

function deletionScrubExecutionScope(
  receipt: ReturnType<typeof scrubReceiptFromRow>,
) {
  const persisted = parsePersistedExecutionScope(receipt.executionScope);
  if (persisted) {
    return deriveExecutionScope(persisted, {
      executingPrincipalType: "system",
      executingPrincipalId: "memory-deletion-scrubber",
      causationId: receipt.id,
      purpose: "memory.deletion.physical-scrub",
    });
  }
  const scopeId = createHash("sha256")
    .update(`${receipt.tenantId}\0${receipt.id}`)
    .digest("hex");
  return createExecutionScope({
    tenantId: receipt.tenantId,
    initiatingActorId: null,
    executingPrincipalType: "system",
    executingPrincipalId: "memory-deletion-scrubber",
    correlationId: `memory-deletion-scrub:${scopeId}`,
    causationId: receipt.id,
    purpose: "memory.deletion.physical-scrub",
  });
}

function scrubReceiptFromRow(row: MemoryDeletionScrubReceiptRow) {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    memoryId: String(row.memory_id),
    descendantMemoryIds: Array.isArray(row.descendant_memory_ids)
      ? row.descendant_memory_ids.map(String)
      : [],
    descendantMemoryCount: Number(row.descendant_memory_count || 0),
    attributionKind: String(row.attribution_kind),
    executionScope: row.execution_scope,
    forgottenAt: canonicalTimestamp(row.forgotten_at),
    createdAt: canonicalTimestamp(row.created_at),
  };
}

function memoryDeletionScrubEventId(tenantId: string, receiptId: string) {
  return `memory_deletion_scrub_${createHash("sha256")
    .update(`${tenantId}\0${receiptId}`)
    .digest("hex")}`;
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Memory deletion scrub receipt has an invalid timestamp.");
  }
  return date.toISOString();
}
