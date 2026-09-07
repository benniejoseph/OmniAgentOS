import { randomUUID } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildTrashActionPreviewV1,
  buildTrashEffectReceiptV1,
  buildTrashItemV1,
  trashActionPreviewV1Schema,
  trashEffectReceiptV1Schema,
  trashItemV1Schema,
  type TrashActionPreviewV1,
  type TrashEffectReceiptV1,
  type TrashItemV1,
  type TrashResourceType,
} from "@/lib/trash/contracts";

const DEFAULT_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PREVIEW_WINDOW_MS = 10 * 60 * 1_000;

type TrashSnapshot = Readonly<Record<string, unknown>>;

type StoredTrashRecord = {
  item: TrashItemV1;
  snapshot: TrashSnapshot | null;
};

type TrashLedger = {
  records: StoredTrashRecord[];
  receipts: TrashEffectReceiptV1[];
};

export type TrashMutationScope = {
  executionScope: ExecutionScope;
};

export type CreateTrashPreviewInput = {
  resourceType: TrashResourceType;
  resourceId: string;
  target: unknown;
  effectSummary: string;
  now?: string;
  previewWindowMs?: number;
};

export type CreateTrashEntryInput = {
  preview: TrashActionPreviewV1;
  displayLabel: string;
  target: unknown;
  snapshot: TrashSnapshot;
  compensation: TrashItemV1["compensation"];
  restoreWindowMs?: number;
  now?: string;
};

export type TrashLifecycleResult = Readonly<{
  item: TrashItemV1;
  receipt: TrashEffectReceiptV1;
}>;

export function createTrashPreview(
  input: CreateTrashPreviewInput,
): TrashActionPreviewV1 {
  const issuedAt = timestamp(input.now);
  return buildTrashActionPreviewV1({
    version: "p9.3-trash-preview:1",
    action: "trash",
    trashId: null,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    lifecycleRevision: 0,
    targetSha256: canonicalJsonSha256(input.target),
    effectSummary: input.effectSummary,
    reversible: true,
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + previewWindow(input.previewWindowMs),
    ).toISOString(),
  });
}

export async function createTrashEntry(
  input: CreateTrashEntryInput,
  options: TrashMutationScope,
): Promise<TrashLifecycleResult> {
  const executionScope = requireTrashScope(options.executionScope);
  const preview = trashActionPreviewV1Schema.parse(input.preview);
  const now = timestamp(input.now);
  assertFreshPreview(preview, now);
  if (preview.action !== "trash" || preview.trashId !== null) {
    throw new Error("Creating a trash item requires a pre-trash preview.");
  }
  if (preview.lifecycleRevision !== 0) {
    throw new Error("A pre-trash preview must target revision zero.");
  }
  const targetSha256 = canonicalJsonSha256(input.target);
  if (preview.targetSha256 !== targetSha256) {
    throw new Error("Trash target changed after preview.");
  }
  const snapshot = normalizeSnapshot(input.snapshot);
  const snapshotSha256 = canonicalJsonSha256(snapshot);

  const prior = await getTrashResultByPreview(preview.previewSha256, executionScope);
  if (prior) return prior;

  const trashId = `trash:${randomUUID()}`;
  const item = buildTrashItemV1({
    version: "p9.3-trash-item:1",
    trashId,
    tenantId: executionScope.tenantId,
    ownerActorId: executionScope.initiatingActorId,
    resourceType: preview.resourceType,
    resourceId: preview.resourceId,
    displayLabel: input.displayLabel,
    targetSha256,
    snapshotSha256,
    compensation: input.compensation,
    state: "retained",
    lifecycleRevision: 1,
    trashedAt: now,
    restoreUntil: new Date(
      Date.parse(now) + restoreWindow(input.restoreWindowMs),
    ).toISOString(),
    restoredAt: null,
    purgedAt: null,
  });
  const receipt = buildTrashEffectReceiptV1({
    version: "p9.3-trash-effect-receipt:1",
    action: "trash",
    trashId,
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    targetSha256: item.targetSha256,
    previewSha256: preview.previewSha256,
    beforeState: null,
    afterState: "retained",
    beforeRevision: 0,
    afterRevision: 1,
    outcome: "applied",
    affectedResourceIds: [item.resourceId],
    occurredAt: now,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sql = getSql();
    return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
      const existing = await getTrashResultByPreview(
        preview.previewSha256,
        executionScope,
        transaction,
      );
      if (existing) return existing;
      await transaction`
        INSERT INTO omni_trash_items (
          tenant_id, owner_actor_id, trash_id, resource_type, resource_id,
          target_sha256, snapshot_sha256, state, lifecycle_revision,
          item, snapshot, trashed_at, restore_until
        ) VALUES (
          ${item.tenantId}, ${item.ownerActorId}, ${item.trashId},
          ${item.resourceType}, ${item.resourceId}, ${item.targetSha256},
          ${item.snapshotSha256}, ${item.state}, ${item.lifecycleRevision},
          ${item}::jsonb, ${snapshot}::jsonb, ${item.trashedAt},
          ${item.restoreUntil}
        )
      `;
      await persistReceipt(receipt, item, transaction);
      await appendTrashEvent(item, receipt, executionScope, transaction);
      return { item, receipt };
    }) as Promise<TrashLifecycleResult>;
  }

  let result: TrashLifecycleResult = { item, receipt };
  await updateJsonFile<TrashLedger>(trashFile(), emptyLedger(), (ledger) => {
    const existingReceipt = ledger.receipts.find(
      (candidate) => candidate.previewSha256 === preview.previewSha256,
    );
    if (existingReceipt) {
      const existingRecord = ledger.records.find(
        (candidate) => candidate.item.trashId === existingReceipt.trashId,
      );
      if (!existingRecord) throw new Error("Trash receipt has no matching item.");
      result = {
        item: trashItemV1Schema.parse(existingRecord.item),
        receipt: trashEffectReceiptV1Schema.parse(existingReceipt),
      };
      return ledger;
    }
    return {
      records: [{ item, snapshot }, ...ledger.records],
      receipts: [receipt, ...ledger.receipts],
    };
  });
  if (result.receipt === receipt) {
    await appendTrashEvent(item, receipt, executionScope);
  }
  return result;
}

export async function listTrashItems(
  options: TrashMutationScope & {
    state?: TrashItemV1["state"];
    limit?: number;
  },
): Promise<TrashItemV1[]> {
  const scope = requireTrashScope(options.executionScope);
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = options.state
      ? await getSql()`
          SELECT item FROM omni_trash_items
          WHERE tenant_id = ${scope.tenantId}
            AND owner_actor_id = ${scope.initiatingActorId}
            AND state = ${options.state}
          ORDER BY trashed_at DESC, trash_id ASC LIMIT ${limit}
        `
      : await getSql()`
          SELECT item FROM omni_trash_items
          WHERE tenant_id = ${scope.tenantId}
            AND owner_actor_id = ${scope.initiatingActorId}
          ORDER BY trashed_at DESC, trash_id ASC LIMIT ${limit}
        `;
    return rows.map((row) => trashItemV1Schema.parse(row.item));
  }
  const ledger = await readTrashLedger();
  return ledger.records
    .filter(({ item }) =>
      item.tenantId === scope.tenantId &&
      item.ownerActorId === scope.initiatingActorId &&
      (!options.state || item.state === options.state)
    )
    .sort((left, right) =>
      right.item.trashedAt.localeCompare(left.item.trashedAt) ||
      left.item.trashId.localeCompare(right.item.trashId)
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

export async function getTrashItem(
  trashId: string,
  options: TrashMutationScope,
): Promise<TrashItemV1 | undefined> {
  return (await getStoredTrashRecord(
    trashId,
    requireTrashScope(options.executionScope),
  ))?.item;
}

export async function getTrashLifecycleResultByPreview(
  previewSha256: string,
  options: TrashMutationScope,
): Promise<TrashLifecycleResult | undefined> {
  return getTrashResultByPreview(
    previewSha256,
    requireTrashScope(options.executionScope),
  );
}

/** Internal-only snapshot read. Application transports must never return it. */
export async function getTrashSnapshot(
  trashId: string,
  options: TrashMutationScope,
): Promise<Readonly<{ item: TrashItemV1; snapshot: TrashSnapshot }> | undefined> {
  const record = await getStoredTrashRecord(
    trashId,
    requireTrashScope(options.executionScope),
  );
  if (!record || record.item.state !== "retained" || !record.snapshot) {
    return undefined;
  }
  if (canonicalJsonSha256(record.snapshot) !== record.item.snapshotSha256) {
    throw new Error("Trash snapshot integrity check failed.");
  }
  return { item: record.item, snapshot: record.snapshot };
}

export async function createTrashLifecyclePreview(
  trashId: string,
  action: "restore" | "purge",
  options: TrashMutationScope & { now?: string; previewWindowMs?: number },
): Promise<TrashActionPreviewV1 | undefined> {
  const scope = requireTrashScope(options.executionScope);
  const record = await getStoredTrashRecord(trashId, scope);
  if (!record) return undefined;
  if (record.item.state !== "retained") {
    throw new Error("Only retained trash items can be restored or purged.");
  }
  const issuedAt = timestamp(options.now);
  if (action === "restore" && Date.parse(issuedAt) > Date.parse(record.item.restoreUntil)) {
    throw new Error("This trash item is past its restore window.");
  }
  return buildTrashActionPreviewV1({
    version: "p9.3-trash-preview:1",
    action,
    trashId,
    resourceType: record.item.resourceType,
    resourceId: record.item.resourceId,
    lifecycleRevision: record.item.lifecycleRevision,
    targetSha256: record.item.targetSha256,
    effectSummary: action === "restore"
      ? `Restore ${record.item.displayLabel} from trash.`
      : `Permanently purge ${record.item.displayLabel}; this cannot be undone.`,
    reversible: action === "restore",
    issuedAt,
    expiresAt: new Date(
      Date.parse(issuedAt) + previewWindow(options.previewWindowMs),
    ).toISOString(),
  });
}

export async function commitTrashLifecycle(
  previewInput: TrashActionPreviewV1,
  options: TrashMutationScope & {
    now?: string;
    affectedResourceIds?: readonly string[];
  },
): Promise<TrashLifecycleResult> {
  const scope = requireTrashScope(options.executionScope);
  const preview = trashActionPreviewV1Schema.parse(previewInput);
  const now = timestamp(options.now);
  assertFreshPreview(preview, now);
  if (preview.action === "trash" || !preview.trashId) {
    throw new Error("A retained trash item is required for this lifecycle action.");
  }

  const prior = await getTrashResultByPreview(preview.previewSha256, scope);
  if (prior) return prior;
  const currentRecord = await getStoredTrashRecord(preview.trashId, scope);
  if (!currentRecord) throw new Error("Trash item not found.");
  assertLifecycleTarget(currentRecord.item, preview, now);
  const afterState = preview.action === "restore" ? "restored" as const : "purged" as const;
  const nextItem = buildTrashItemV1({
    ...withoutItemDigest(currentRecord.item),
    state: afterState,
    lifecycleRevision: currentRecord.item.lifecycleRevision + 1,
    restoredAt: afterState === "restored" ? now : null,
    purgedAt: afterState === "purged" ? now : null,
  });
  const receipt = lifecycleReceipt(
    currentRecord.item,
    nextItem,
    preview,
    now,
    options.affectedResourceIds,
  );

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sql = getSql();
    return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
      const existing = await getTrashResultByPreview(
        preview.previewSha256,
        scope,
        transaction,
      );
      if (existing) return existing;
      const rows = await transaction`
        UPDATE omni_trash_items
        SET state = ${nextItem.state},
            lifecycle_revision = ${nextItem.lifecycleRevision},
            item = ${nextItem}::jsonb,
            snapshot = NULL,
            terminal_at = ${now}
        WHERE tenant_id = ${scope.tenantId}
          AND owner_actor_id = ${scope.initiatingActorId}
          AND trash_id = ${nextItem.trashId}
          AND state = 'retained'
          AND lifecycle_revision = ${currentRecord.item.lifecycleRevision}
          AND target_sha256 = ${preview.targetSha256}
        RETURNING trash_id
      `;
      if (!rows[0]) throw new Error("Trash item changed after preview.");
      await persistReceipt(receipt, nextItem, transaction);
      await appendTrashEvent(nextItem, receipt, scope, transaction);
      return { item: nextItem, receipt };
    }) as Promise<TrashLifecycleResult>;
  }

  let result: TrashLifecycleResult = { item: nextItem, receipt };
  await updateJsonFile<TrashLedger>(trashFile(), emptyLedger(), (ledger) => {
    const existingReceipt = ledger.receipts.find(
      (candidate) => candidate.previewSha256 === preview.previewSha256,
    );
    if (existingReceipt) {
      const existingRecord = ledger.records.find(
        (candidate) => candidate.item.trashId === existingReceipt.trashId,
      );
      if (!existingRecord) throw new Error("Trash receipt has no matching item.");
      result = { item: existingRecord.item, receipt: existingReceipt };
      return ledger;
    }
    const index = ledger.records.findIndex(({ item }) =>
      item.trashId === nextItem.trashId &&
      item.tenantId === scope.tenantId &&
      item.ownerActorId === scope.initiatingActorId
    );
    if (index < 0 || ledger.records[index].item.itemSha256 !== currentRecord.item.itemSha256) {
      throw new Error("Trash item changed after preview.");
    }
    const records = [...ledger.records];
    records[index] = { item: nextItem, snapshot: null };
    return { records, receipts: [receipt, ...ledger.receipts] };
  });
  if (result.receipt === receipt) {
    await appendTrashEvent(nextItem, receipt, scope);
  }
  return result;
}

export async function expireTrashItems(
  options: TrashMutationScope & { now?: string; limit?: number },
): Promise<TrashLifecycleResult[]> {
  const scope = requireTrashScope(options.executionScope);
  const now = timestamp(options.now);
  const retained = await listTrashItems({
    executionScope: scope,
    state: "retained",
    limit: options.limit || 100,
  });
  const expired = retained.filter((item) => Date.parse(item.restoreUntil) <= Date.parse(now));
  const results: TrashLifecycleResult[] = [];
  for (const current of expired) {
    results.push(await commitAutomaticExpiry(current, scope, now));
  }
  return results;
}

async function commitAutomaticExpiry(
  current: TrashItemV1,
  scope: ExecutionScope & { initiatingActorId: string },
  now: string,
): Promise<TrashLifecycleResult> {
  const previewSha256 = canonicalJsonSha256({
    action: "expire",
    trashId: current.trashId,
    itemSha256: current.itemSha256,
    restoreUntil: current.restoreUntil,
  });
  const prior = await getTrashResultByPreview(previewSha256, scope);
  if (prior) return prior;
  const nextItem = buildTrashItemV1({
    ...withoutItemDigest(current),
    state: "expired",
    lifecycleRevision: current.lifecycleRevision + 1,
    restoredAt: null,
    purgedAt: now,
  });
  const receipt = buildTrashEffectReceiptV1({
    version: "p9.3-trash-effect-receipt:1",
    action: "expire",
    trashId: current.trashId,
    resourceType: current.resourceType,
    resourceId: current.resourceId,
    targetSha256: current.targetSha256,
    previewSha256,
    beforeState: current.state,
    afterState: "expired",
    beforeRevision: current.lifecycleRevision,
    afterRevision: nextItem.lifecycleRevision,
    outcome: "applied",
    affectedResourceIds: [current.resourceId],
    occurredAt: now,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (transaction: ReturnType<typeof getSql>) => {
      const rows = await transaction`
        UPDATE omni_trash_items
        SET state = 'expired', lifecycle_revision = ${nextItem.lifecycleRevision},
            item = ${nextItem}::jsonb, snapshot = NULL, terminal_at = ${now}
        WHERE tenant_id = ${scope.tenantId}
          AND owner_actor_id = ${scope.initiatingActorId}
          AND trash_id = ${current.trashId}
          AND state = 'retained'
          AND lifecycle_revision = ${current.lifecycleRevision}
          AND restore_until <= ${now}
        RETURNING trash_id
      `;
      if (!rows[0]) throw new Error("Trash item changed before expiry.");
      await persistReceipt(receipt, nextItem, transaction);
      await appendTrashEvent(nextItem, receipt, scope, transaction);
      return { item: nextItem, receipt };
    }) as Promise<TrashLifecycleResult>;
  }

  await updateJsonFile<TrashLedger>(trashFile(), emptyLedger(), (ledger) => {
    const index = ledger.records.findIndex(({ item }) =>
      item.itemSha256 === current.itemSha256 &&
      item.tenantId === scope.tenantId &&
      item.ownerActorId === scope.initiatingActorId
    );
    if (index < 0) throw new Error("Trash item changed before expiry.");
    const records = [...ledger.records];
    records[index] = { item: nextItem, snapshot: null };
    return { records, receipts: [receipt, ...ledger.receipts] };
  });
  await appendTrashEvent(nextItem, receipt, scope);
  return { item: nextItem, receipt };
}

async function getStoredTrashRecord(
  trashId: string,
  scope: ExecutionScope & { initiatingActorId: string },
  sql?: ReturnType<typeof getSql>,
): Promise<StoredTrashRecord | undefined> {
  if (hasDatabaseUrl()) {
    if (!sql) await ensureDatabaseSchema();
    const rows = await (sql || getSql())`
      SELECT item, snapshot FROM omni_trash_items
      WHERE tenant_id = ${scope.tenantId}
        AND owner_actor_id = ${scope.initiatingActorId}
        AND trash_id = ${trashId}
      LIMIT 1
    `;
    if (!rows[0]) return undefined;
    return {
      item: trashItemV1Schema.parse(rows[0].item),
      snapshot: rows[0].snapshot ? normalizeSnapshot(rows[0].snapshot) : null,
    };
  }
  const ledger = await readTrashLedger();
  return ledger.records.find(({ item }) =>
    item.trashId === trashId &&
    item.tenantId === scope.tenantId &&
    item.ownerActorId === scope.initiatingActorId
  );
}

async function getTrashResultByPreview(
  previewSha256: string,
  scope: ExecutionScope & { initiatingActorId: string },
  sql?: ReturnType<typeof getSql>,
): Promise<TrashLifecycleResult | undefined> {
  if (hasDatabaseUrl()) {
    if (!sql) await ensureDatabaseSchema();
    const rows = await (sql || getSql())`
      SELECT effect.receipt AS receipt, item.item AS item
      FROM omni_trash_effect_receipts effect
      JOIN omni_trash_items item
        ON item.tenant_id = effect.tenant_id
       AND item.owner_actor_id = effect.owner_actor_id
       AND item.trash_id = effect.trash_id
      WHERE effect.tenant_id = ${scope.tenantId}
        AND effect.owner_actor_id = ${scope.initiatingActorId}
        AND effect.preview_sha256 = ${previewSha256}
      LIMIT 1
    `;
    if (!rows[0]) return undefined;
    return {
      item: trashItemV1Schema.parse(rows[0].item),
      receipt: trashEffectReceiptV1Schema.parse(rows[0].receipt),
    };
  }
  const ledger = await readTrashLedger();
  const receipt = ledger.receipts.find((candidate) =>
    candidate.previewSha256 === previewSha256 &&
    ledger.records.some(({ item }) =>
      item.trashId === candidate.trashId &&
      item.tenantId === scope.tenantId &&
      item.ownerActorId === scope.initiatingActorId
    )
  );
  if (!receipt) return undefined;
  const record = ledger.records.find(({ item }) => item.trashId === receipt.trashId);
  if (!record) throw new Error("Trash receipt has no matching item.");
  return { item: record.item, receipt };
}

async function persistReceipt(
  receipt: TrashEffectReceiptV1,
  item: TrashItemV1,
  sql: ReturnType<typeof getSql>,
) {
  await sql`
    INSERT INTO omni_trash_effect_receipts (
      tenant_id, owner_actor_id, receipt_sha256, preview_sha256, trash_id,
      action, receipt, occurred_at
    ) VALUES (
      ${item.tenantId}, ${item.ownerActorId},
      ${receipt.receiptSha256}, ${receipt.previewSha256}, ${receipt.trashId},
      ${receipt.action}, ${receipt}::jsonb, ${receipt.occurredAt}
    )
  `;
}

async function appendTrashEvent(
  item: TrashItemV1,
  receipt: TrashEffectReceiptV1,
  executionScope: ExecutionScope,
  sql?: ReturnType<typeof getSql>,
) {
  await appendScopedDomainEvent({
    id: `trash-event:v1:${receipt.receiptSha256}`,
    streamId: `trash:${item.trashId}`,
    type: `trash.item.${receipt.action === "trash" ? "created" : `${receipt.action}d`}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      trashId: item.trashId,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      targetSha256: item.targetSha256,
      snapshotSha256: item.snapshotSha256,
      state: item.state,
      lifecycleRevision: item.lifecycleRevision,
      receiptSha256: receipt.receiptSha256,
    },
  }, sql ? { sql } : {});
}

function lifecycleReceipt(
  current: TrashItemV1,
  next: TrashItemV1,
  preview: TrashActionPreviewV1,
  now: string,
  affectedResourceIds?: readonly string[],
) {
  return buildTrashEffectReceiptV1({
    version: "p9.3-trash-effect-receipt:1",
    action: preview.action === "restore" ? "restore" : "purge",
    trashId: current.trashId,
    resourceType: current.resourceType,
    resourceId: current.resourceId,
    targetSha256: current.targetSha256,
    previewSha256: preview.previewSha256,
    beforeState: current.state,
    afterState: next.state,
    beforeRevision: current.lifecycleRevision,
    afterRevision: next.lifecycleRevision,
    outcome: "applied",
    affectedResourceIds: affectedResourceIds?.length
      ? [...new Set(affectedResourceIds)]
      : [current.resourceId],
    occurredAt: now,
  });
}

function assertLifecycleTarget(
  item: TrashItemV1,
  preview: TrashActionPreviewV1,
  now: string,
) {
  if (
    item.state !== "retained" ||
    item.trashId !== preview.trashId ||
    item.resourceType !== preview.resourceType ||
    item.resourceId !== preview.resourceId ||
    item.lifecycleRevision !== preview.lifecycleRevision ||
    item.targetSha256 !== preview.targetSha256
  ) {
    throw new Error("Trash item changed after preview.");
  }
  if (preview.action === "restore" && Date.parse(now) > Date.parse(item.restoreUntil)) {
    throw new Error("This trash item is past its restore window.");
  }
}

function requireTrashScope(
  value: ExecutionScope,
): ExecutionScope & { initiatingActorId: string } {
  const scope = parsePersistedExecutionScope(value);
  if (!scope || !scope.initiatingActorId) {
    throw new Error("Trash operations require an actor-bound execution scope.");
  }
  assertExecutionScopeTenant(scope, scope.tenantId);
  return scope as ExecutionScope & { initiatingActorId: string };
}

function assertFreshPreview(preview: TrashActionPreviewV1, now: string) {
  if (Date.parse(now) < Date.parse(preview.issuedAt)) {
    throw new Error("Trash preview is not active yet.");
  }
  if (Date.parse(now) > Date.parse(preview.expiresAt)) {
    throw new Error("Trash preview has expired.");
  }
}

function normalizeSnapshot(value: unknown): TrashSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trash snapshots must be closed JSON objects.");
  }
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 1_000_000) {
    throw new Error("Trash snapshot exceeds the one-megabyte limit.");
  }
  return Object.freeze(JSON.parse(serialized) as Record<string, unknown>);
}

function withoutItemDigest(item: TrashItemV1) {
  const { itemSha256: _itemSha256, ...body } = item;
  void _itemSha256;
  return body;
}

function timestamp(value?: string) {
  const result = value ? new Date(value) : new Date();
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid trash timestamp.");
  return result.toISOString();
}

function restoreWindow(value?: number) {
  const window = value ?? DEFAULT_RESTORE_WINDOW_MS;
  if (!Number.isSafeInteger(window) || window < 60_000 || window > 90 * 24 * 60 * 60 * 1_000) {
    throw new Error("Trash restore window must be between one minute and ninety days.");
  }
  return window;
}

function previewWindow(value?: number) {
  const window = value ?? DEFAULT_PREVIEW_WINDOW_MS;
  if (!Number.isSafeInteger(window) || window < 1_000 || window > 30 * 60 * 1_000) {
    throw new Error("Trash preview window must be between one second and thirty minutes.");
  }
  return window;
}

async function readTrashLedger(): Promise<TrashLedger> {
  const ledger = await readJsonFile<TrashLedger>(trashFile(), emptyLedger());
  return {
    records: ledger.records.map((record) => ({
      item: trashItemV1Schema.parse(record.item),
      snapshot: record.snapshot ? normalizeSnapshot(record.snapshot) : null,
    })),
    receipts: ledger.receipts.map((receipt) => trashEffectReceiptV1Schema.parse(receipt)),
  };
}

function emptyLedger(): TrashLedger {
  return { records: [], receipts: [] };
}

function trashFile() {
  return getDataPath("trash-ledger.json");
}
