export type ReindexTarget = Readonly<{ id: string; filename: string; tenantId: string; actorId: string; contentSha256: string; byteCount: number; mediaType: string }>;
export type ReindexSubmission = Readonly<{ target: ReindexTarget; key: string; body: "{}" }>;
export type ReindexReceipt = Readonly<{ assetId: string; jobId: string; status: "queued" | "running" | "completed" | "failed" | "canceled"; duplicate: boolean; repaired: boolean; receiptSha256: string }>;
export type ReindexRow = Readonly<{ submission: ReindexSubmission; state: "waiting" | "sending" | "accepted" | "unconfirmed" | "refused" | "not_sent"; receipt?: ReindexReceipt; message?: string }>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max = 240): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireReceipt(value: unknown): asserts value { if (!value) throw new Error("The indexing receipt could not be verified. The request may have been accepted; refresh the source status before another request."); }
export async function reindexTextSha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function reindexJsonSha256(value: unknown) {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort) : object(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])])) : entry;
  return reindexTextSha256(JSON.stringify(sort(JSON.parse(JSON.stringify(value)))));
}
export function freezeReindexSubmission(value: ReindexTarget, owner: { tenantId: string; actorId: string }, key: string): ReindexSubmission {
  requireReceipt(text(value.id, 200) && /^[a-zA-Z0-9_-]+$/.test(value.id) && text(value.filename, 500) && value.tenantId === owner.tenantId && value.actorId === owner.actorId &&
    hash(value.contentSha256) && Number.isSafeInteger(value.byteCount) && value.byteCount >= 0 && text(value.mediaType, 160) && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/.test(key));
  return Object.freeze({ target: Object.freeze({ id: value.id, filename: value.filename, tenantId: value.tenantId, actorId: value.actorId,
    contentSha256: value.contentSha256, byteCount: value.byteCount, mediaType: value.mediaType }), key, body: "{}" });
}

/** Confirms the exact source and public job receipt; acceptance is independent of a later list refresh. */
export async function readReindexReceipt(value: unknown, submitted: ReindexSubmission): Promise<ReindexReceipt> {
  requireReceipt(object(value) && object(value.asset) && object(value.job) && object(value.serviceReceipt));
  const { asset, job, serviceReceipt: receipt, ...flags } = value;
  const target = submitted.target;
  requireReceipt(asset.id === target.id && asset.tenantId === target.tenantId && asset.actorId === target.actorId && asset.filename === target.filename &&
    asset.contentSha256 === target.contentSha256 && asset.byteCount === target.byteCount && asset.mediaType === target.mediaType &&
    text(job.id, 200) && /^[a-zA-Z0-9_-]+$/.test(job.id) && ["capture.asset.process", "knowledge.ingest"].includes(String(job.type)) &&
    ["queued", "running", "completed", "failed", "canceled"].includes(String(job.status)) && asset.ingestJobId === job.id);
  requireReceipt((flags.duplicate === undefined || typeof flags.duplicate === "boolean") && (flags.repaired === undefined || typeof flags.repaired === "boolean") &&
    Object.keys(flags).every((key) => key === "duplicate" || key === "repaired") && (!flags.repaired || flags.duplicate === true && job.status === "completed" && asset.status === "indexed"));
  const receiptFields = ["schemaVersion", "receiptKind", "boundaryVersion", "operation", "action", "resourceType", "accessMode", "eventContract", "resourceCount", "authoritySha256", "idempotencyKeySha256", "outcomeSha256", "occurredAt", "receiptSha256"];
  requireReceipt(Object.keys(receipt).length === receiptFields.length && receiptFields.every((key) => Object.hasOwn(receipt, key)) &&
    receipt.schemaVersion === 1 && receipt.receiptKind === "app_service_receipt" && receipt.boundaryVersion === "p9.1-app-service-boundary:1" &&
    receipt.operation === "app.assets.index" && receipt.action === "write.memory" && receipt.resourceType === "capture_asset" && receipt.accessMode === "mutation" &&
    receipt.eventContract === "capture-events.v1" && receipt.resourceCount === 1 && hash(receipt.authoritySha256) && hash(receipt.receiptSha256) &&
    typeof receipt.occurredAt === "string" && Number.isFinite(Date.parse(receipt.occurredAt)));
  const { receiptSha256, ...receiptBody } = receipt;
  requireReceipt(receipt.idempotencyKeySha256 === await reindexTextSha256(`${target.tenantId}\u0000${submitted.key}`) &&
    receipt.outcomeSha256 === await reindexJsonSha256({ asset, job, ...flags }) && receiptSha256 === await reindexJsonSha256(receiptBody));
  return Object.freeze({ assetId: target.id, jobId: job.id, status: job.status as ReindexReceipt["status"], duplicate: flags.duplicate === true,
    repaired: flags.repaired === true, receiptSha256: receiptSha256 as string });
}

export function reindexReceiptLabel(receipt: ReindexReceipt) {
  if (receipt.repaired) return "Existing completed job · source index repaired";
  const status = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", canceled: "Canceled" }[receipt.status];
  return `${receipt.duplicate ? "Existing job" : "Accepted job"} · ${status}`;
}

/** Local admission only. Disposal never claims to cancel an already-sent server request. */
export function createReindexGate() {
  let scope = "", epoch = 0;
  let heldScope = "";
  let active: Readonly<{ scope: string; epoch: number }> | undefined;
  const uncertain = new Map<string, ReindexRow>();
  return {
    enter(next: string) {
      if (next && next !== heldScope) { uncertain.clear(); heldScope = next; }
      scope = next; epoch++; active = undefined;
    },
    // Effect cleanup also runs during same-owner re-verification. Keep its hold
    // inaccessible until the same exact scope returns; a new verified scope clears it.
    dispose() { scope = ""; epoch++; active = undefined; },
    begin(expected: string) { if (!scope || scope !== expected || active) return undefined; active = Object.freeze({ scope, epoch }); return active; },
    current(token: Readonly<{ scope: string; epoch: number }>) { return active === token && scope === token.scope && epoch === token.epoch; },
    finish(token: Readonly<{ scope: string; epoch: number }>) { if (active === token) active = undefined; },
    hold(token: Readonly<{ scope: string; epoch: number }>, row: ReindexRow) {
      if (active === token && epoch === token.epoch && row.state === "unconfirmed") uncertain.set(row.submission.target.id, row);
    },
    held(expected: string, assetId: string) { return Boolean(scope) && scope === expected && uncertain.has(assetId); },
    heldRows(expected: string) { return scope && scope === expected ? [...uncertain.values()] : []; },
  };
}

export async function runReindexBatch<T, R>(items: readonly T[], current: () => boolean, worker: (item: T, index: number) => Promise<R>) {
  let cursor = 0;
  const results: Array<R | undefined> = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (current() && cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}
